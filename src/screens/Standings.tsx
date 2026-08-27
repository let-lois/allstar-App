import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SectionHeader } from '../components/ui/Card'
import { Avatar } from '../components/ui/Avatar'
import { useAppStore } from '../store/useAppStore'
import { useTeamStats } from '../store/teamStats'
import {
  PERIODS,
  POINTS,
  awards,
  boardFor,
  periodLabel,
  standings,
  type Period,
} from '../data/leaderboard'
import { money } from '../lib/format'
import { IconChevron } from '../components/nav/icons'

/**
 * Today's standings.
 *
 * Door-to-door runs on this. A rep who cannot see where they stand at 2pm has no
 * reason to knock the next street, and every manager in this industry already
 * keeps the board on a whiteboard — the app either holds it or the whiteboard
 * does.
 *
 * Written for the rep first, not the manager. The manager already has the Team
 * screen and the console; what a rep needs is to find their own row in under a
 * second, from a truck, in sunlight. So their row is marked, pinned into view
 * with the leaders, and the scoring rules are on the screen rather than in
 * somebody's head.
 *
 * **Nobody is called last.** Ranks are shown, the order is honest, and the board
 * is complete — but there is no bottom-of-the-table styling, no red, and no
 * "needs improvement". The number does the work. Publicly decorating the last
 * row is how a leaderboard stops being motivating and starts being the reason
 * somebody quits, and a team of five has a last place every single day.
 */
export function Standings() {
  const nav = useNavigate()
  const me = useAppStore((s) => s.user)
  const reps = useTeamStats()
  const history = useAppStore((s) => s.dailyStats)

  /*
    Today by default, every time the screen opens.

    Not remembered between visits on purpose: at 2pm the question is about this
    afternoon, and a rep who looked at the month once last week should not have
    to notice a filter before they trust the number in front of them.
  */
  const [period, setPeriod] = useState<Period>('today')
  /*
    The company's calendar. History rows were bucketed on it by the server, so
    the week and month bounds have to be asked on it too — a phone in another
    timezone otherwise drops a day out of a week, or counts it twice.
  */
  const tz = useAppStore((s) => s.timezone)

  const scored = useMemo(
    () => boardFor(period, { live: reps, history: Object.values(history), tz }),
    [period, reps, history, tz],
  )
  const board = useMemo(() => standings(scored), [scored])
  const prizes = useMemo(() => awards(scored), [scored])
  const mine = board.find((r) => r.rep.id === me?.id)

  const totalDoors = scored.reduce((s, r) => s + r.knocks, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title="Standings"
        subtitle={periodLabel(period, undefined, tz)}
        back
      />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col page anim-rise">
          {/*
            Today, Week, Month. A row of three rather than a dropdown: it is one
            tap from any of them to any other, all three are readable without
            opening anything, and a rep in sunlight can hit a 44px chip.
          */}
          <div className="snap-x-row -mx-1 px-1 pb-1" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                aria-pressed={period === p.key}
                className={`press focusable metal min-h-tap shrink-0 rounded-full px-5 text-[14px] font-semibold ${
                  period === p.key ? 'metal-brand' : 'metal-quiet !text-ink-mute'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {reps.length === 0 ? (
            <p className="card px-6 py-8 text-center text-[14px] text-ink-mute">
              No reps on this account yet. The board fills in as soon as somebody
              starts knocking.
            </p>
          ) : (
            <>
              {/*
                Your own line first, and only if you are on the board. A manager
                looking at their team does not have a row here, and inventing one
                for them would put an admin with no route at the bottom of a
                league table of people who knock doors.
              */}
              {mine && (
                <section className="card p-5">
                  {/*
                    Follows the switch. "You today" above a week's points is the
                    kind of small lie that makes a rep distrust the whole board.
                  */}
                  <p className="text-[12.5px] font-medium text-ink-mute">
                    {period === 'today' ? 'You today' : `You this ${period}`}
                  </p>
                  <div className="mt-1 flex items-baseline gap-2.5">
                    <span className="nums text-[38px] font-semibold leading-none tracking-[-0.02em] text-accent">
                      {mine.tied ? 'T' : ''}#{mine.rank}
                    </span>
                    <span className="text-[14px] text-ink-mute">
                      of {board.length} · {mine.points.toLocaleString()} points
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-snug text-ink-mute">
                    {mine.rank === 1
                      ? mine.tied
                        ? 'Tied at the top. The next door breaks it.'
                        : 'Top of the board. Hold it.'
                      : `${(board[mine.rank - 2].points - mine.points).toLocaleString()} points behind ${
                          board[mine.rank - 2].rep.name.split(' ')[0]
                        }.`}
                  </p>
                </section>
              )}

              {/* --- awards ------------------------------------------------ */}
              {prizes.length > 0 && (
                <section className="section">
                  <SectionHeader
                    title={period === 'today' ? "Today's honours" : `Honours this ${period}`}
                    standalone
                  />
                  <ul className="grid grid-cols-2 gap-3">
                    {prizes.map((a) => (
                      <li key={a.key} className="card p-4">
                        <p className="text-[20px] leading-none" aria-hidden>
                          {a.glyph}
                        </p>
                        <p className="mt-2 text-[12.5px] font-medium text-ink-mute">{a.label}</p>
                        <p className="mt-0.5 truncate text-[15px] font-semibold">
                          {a.winners.map((w) => w.name.split(' ')[0]).join(' & ')}
                        </p>
                        <p className="nums mt-0.5 text-[13px] text-ink-mute">
                          {a.key === 'revenue' ? money(a.value) : a.value.toLocaleString()}
                          {a.key === 'top' ? ' pts' : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* --- the board --------------------------------------------- */}
              <section className="section">
                <SectionHeader title="The board" count={board.length} standalone />
                <ul className="plate -mx-4 overflow-hidden sm:mx-0 sm:rounded-card sm:border" data-tour="standings-board">
                  {board.map(({ rep, rank, points, tied }) => (
                    <li
                      key={rep.id}
                      className={rank > 1 ? 'border-t border-line-soft' : ''}
                    >
                    {/*
                      Tappable through to the day behind the number. A manager
                      scanning the board wants "why is Tony at 54", and a rep
                      wants their own breakdown — both land on the same screen,
                      which is the point: nothing is visible to a manager that is
                      hidden from the person it describes.
                    */}
                    <button
                      onClick={() => nav(`/rep/${rep.id}`)}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field ${
                        rep.id === me?.id ? 'bg-surface-tint' : ''
                      }`}
                    >
                      <span
                        className={`nums w-7 shrink-0 text-center text-[15px] font-semibold ${
                          rank === 1 ? 'text-accent' : 'text-ink-mute'
                        }`}
                      >
                        {tied ? 'T' : ''}
                        {rank}
                      </span>
                      <Avatar initials={rep.initials} name={rep.name} src={rep.avatarUrl} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">
                          {rep.name}
                          {/*
                            The space is not decorative. Without a text node
                            between them the marker runs into the surname —
                            "Dana Whitfieldyou" — which is what a screen reader
                            says out loud and what the gate read before it was
                            fixed. Margin separates pixels, not words.
                          */}
                          {rep.id === me?.id && (
                            <>
                              {' '}
                              <span className="text-[12px] font-normal text-ink-mute">you</span>
                            </>
                          )}
                        </span>
                        {/*
                          The four numbers, in funnel order, on one line. A table
                          with four columns does not fit a 320px phone, and this
                          is a phone screen first — so the columns become a row of
                          labelled figures that wraps rather than clips.
                        */}
                        <span className="nums mt-0.5 flex flex-wrap gap-x-2.5 text-[12.5px] text-ink-mute">
                          <span>{rep.knocks} doors</span>
                          <span>{rep.conversations} convos</span>
                          <span>{rep.appointments} appts</span>
                          <span>{rep.sales} sold</span>
                        </span>
                      </span>
                      <span className="nums shrink-0 text-right">
                        <span className="block text-[15px] font-semibold">
                          {points.toLocaleString()}
                        </span>
                        <span className="block text-[11.5px] text-ink-mute">pts</span>
                      </span>
                      <span className="shrink-0 text-ink-faint" aria-hidden>
                        <IconChevron />
                      </span>
                    </button>
                    </li>
                  ))}
                </ul>
              </section>

              {/*
                The rules, on the screen. A ranking nobody can explain breeds
                suspicion rather than effort — the rep in third needs to know
                exactly what moves them to second.
              */}
              <section className="section">
                <SectionHeader title="How points work" standalone />
                <div className="card p-4">
                  <dl className="grid grid-cols-2 gap-y-2 text-[14px]">
                    <dt className="text-ink-mute">Door knocked</dt>
                    <dd className="nums text-right font-semibold">{POINTS.door}</dd>
                    <dt className="text-ink-mute">Conversation</dt>
                    <dd className="nums text-right font-semibold">{POINTS.conversation}</dd>
                    <dt className="text-ink-mute">Appointment</dt>
                    <dd className="nums text-right font-semibold">{POINTS.appointment}</dd>
                    <dt className="text-ink-mute">Sale</dt>
                    <dd className="nums text-right font-semibold">{POINTS.sale}</dd>
                  </dl>
                  <p className="mt-3 text-[13px] leading-relaxed text-ink-mute">
                    Doors count. A day of knocking for two appointments beats one
                    lucky first door, which is the point — the board should reward
                    working the patch, not skimming it. Resets at midnight; today's
                    {' '}
                    {totalDoors.toLocaleString()} doors are the whole team's.
                  </p>
                </div>
              </section>
            </>
          )}

          <button
            onClick={() => nav('/today')}
            className="focusable mx-auto min-h-[44px] px-3 text-[13px] font-semibold text-accent-strong"
          >
            Back to today
          </button>
        </div>
      </div>
    </div>
  )
}
