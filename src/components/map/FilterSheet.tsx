import { BottomSheet } from '../ui/BottomSheet'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { STATUS_COLOR, STATUS_LABEL } from '../../data/outcomes'
import { VISITED_WINDOWS, activeFilterCount, type MapFilter } from '../../lib/leadFilter'
import type { LeadStatus } from '../../types'

/**
 * Everything the map can be narrowed by, in one place a thumb can reach.
 *
 * It replaces a horizontal rail of fourteen chips, of which three fitted on a
 * 320px screen — so eleven of them could only be reached by swiping a scroller
 * that gave no sign of how much was hidden. Five of the nine statuses had no
 * chip at all; New and Contacted were simply not askable on the map.
 *
 * The sheet is what makes room. Over the map, width is the scarce dimension and
 * every band of chrome costs map; inside a sheet, vertical room is cheap, which
 * is what lets these become grouped sections with headings instead of one
 * undifferentiated scroller. That is the whole trade, and it is why the rail
 * could never have been fixed by shortening it.
 *
 * ## Live, with a count, and no Apply
 *
 * Choices apply as they are made and the primary button says how many leads
 * survive them. An Apply button would be the conventional answer and the wrong
 * one here: it makes every choice provisional, so a rep cannot tell a filter
 * that finds nothing from one they have not committed yet — and "nothing here"
 * is the answer they most need to see immediately, because it means they should
 * pick differently. The button dismisses; it does not decide.
 *
 * ## Modal, unlike the map's other sheets
 *
 * The property peek and the Add-lead form both run with `scrim={false}` so the
 * rep can keep working the map behind them. This one does not, for a reason
 * specific to it: a tap on the map means "add a lead here", and a rep reaching
 * past a filter sheet to see the effect of their choice would create a draft
 * pin instead. The count in the footer is the feedback, and it is better than
 * squinting at pins through a gap.
 */
export function FilterSheet({
  open,
  onClose,
  filter,
  onChange,
  matching,
}: {
  open: boolean
  onClose: () => void
  filter: MapFilter
  onChange: (next: MapFilter) => void
  /** How many leads the current choices leave. Live, and named on the button. */
  matching: number
}) {
  const count = activeFilterCount(filter)

  const chosen = filter.status.kind === 'some' ? filter.status.set : []

  /*
    Tapping a status picks it; tapping the last one back off returns to "Open"
    rather than leaving an empty set that matches nothing. An empty selection
    that hides every lead is a state a rep can reach in one tap and cannot read
    their way out of, so the model does not have one.
  */
  const toggleStatus = (s: LeadStatus) => {
    const next = chosen.includes(s) ? chosen.filter((x) => x !== s) : [...chosen, s]
    onChange({ ...filter, status: next.length ? { kind: 'some', set: next } : { kind: 'open' } })
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Filters"
      /*
        Tall on opening, because the whole point is that nothing is hidden. Four
        sections is more than half a phone screen, and a rep who has to scroll
        to discover that "Last knocked" exists is back where the rail left them
        — the difference being that a vertical scroll at least announces itself.
      */
      detents={[0.86]}
      footer={
        <div className="flex gap-2">
          {/*
            Disabled when there is nothing to clear, rather than hidden. A
            control that comes and goes is one a rep has to look for; one that
            is visibly unavailable also says "nothing is on", which is the
            question they opened this to answer.
          */}
          <Button
            variant="secondary"
            size="lg"
            className="shrink-0"
            disabled={count === 0}
            onClick={() =>
              onChange({
                ...filter,
                status: { kind: 'open' },
                visited: 'any',
                noAnswerOnly: false,
              })
            }
          >
            Clear
          </Button>
          {/*
            The count is the point. It closes the loop on a choice already
            applied, and it is the one number that tells a rep their filter
            found nothing *before* they close the sheet and stare at an empty
            map. `nums` so it does not jitter as they tap.
          */}
          <Button size="lg" full onClick={onClose}>
            {/*
              One text node, not three. Written as `Show <span>{n}</span> leads`
              the JSX whitespace between them renders as visible gaps — "Show
              21  leads" — and `nums` only needs to cover the digits to stop the
              label jittering as they change.
            */}
            <span>
              Show <span className="nums">{matching}</span>
              {matching === 1 ? ' lead' : ' leads'}
            </span>
          </Button>
        </div>
      }
    >
      <div className="space-y-5 pt-1" data-testid="filter-sheet">
        {/*
          No scope section here, deliberately.

          "My route" and "All" are chips on the band outside this sheet, and
          repeating them inside it would put two controls with the same
          accessible name on screen at once — ambiguous to a screen reader
          reading "All, button" twice, and ambiguous to any gate that addresses
          a control by its name. Scope also belongs where its state is visible
          without opening anything: it is the question a rep answers when they
          arrive, not one they go looking for.
        */}
        <Section
          title="Status"
          hint={
            filter.status.kind === 'some'
              ? 'Only the ones you have picked. Tap them off to go back.'
              : filter.status.kind === 'any'
                ? 'Everything, finished leads included.'
                : 'Everything still open — not won, lost or Do Not Contact.'
          }
        >
          {/*
            The two rules first, then the nine statuses, with a hairline
            between. They are different kinds of answer: `Open` and `Everything`
            describe a rule that keeps holding as the app changes, and the nine
            below are a list. Mixing them into one undifferentiated row is what
            put "Open leads" beside four of its own six members on the old rail.
          */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Chip
              size="sm"
              selected={filter.status.kind === 'open'}
              onClick={() => onChange({ ...filter, status: { kind: 'open' } })}
            >
              Open leads
            </Chip>
            <Chip
              size="sm"
              selected={filter.status.kind === 'any'}
              onClick={() => onChange({ ...filter, status: { kind: 'any' } })}
            >
              Any status
            </Chip>
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(STATUS_LABEL) as LeadStatus[]).map((s) => (
              <Chip
                key={s}
                size="sm"
                selected={chosen.includes(s)}
                onClick={() => toggleStatus(s)}
              >
                {/*
                  The dot carries the same hue the pin does. A rep reading the
                  map is matching colours, not words, and a status list with no
                  colour on it makes them translate twice.
                */}
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: STATUS_COLOR[s] }}
                />
                {STATUS_LABEL[s]}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title="Last knocked" hint="One answer: a door cannot be both unknocked and knocked today.">
          {/*
            `group`, not `radiogroup`. A radiogroup's children have to be
            `role="radio"` with `aria-checked`; these are `aria-pressed`
            buttons, and the pairing is invalid — a screen reader is told there
            are radios and then finds none. The View switch on this screen uses
            the same group-plus-pressed pattern.
          */}
          <div role="group" aria-label="Last knocked" className="flex flex-wrap gap-2">
            {VISITED_WINDOWS.map((w) => (
              <Chip
                key={w.key}
                size="sm"
                selected={filter.visited === w.key}
                onClick={() => onChange({ ...filter, visited: w.key })}
              >
                {w.label}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title="Outcome" hint="Worth another try at a different hour.">
          <Chip
            size="sm"
            selected={filter.noAnswerOnly}
            onClick={() => onChange({ ...filter, noAnswerOnly: !filter.noAnswerOnly })}
          >
            No answer
          </Chip>
        </Section>
      </div>
    </BottomSheet>
  )
}

/** A titled group. The thing the rail could not have, and the reason for the sheet. */
function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="eyebrow">{title}</h3>
      <p className="mb-2 mt-0.5 text-[12.5px] text-ink-mute">{hint}</p>
      {children}
    </section>
  )
}
