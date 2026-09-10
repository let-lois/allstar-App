import { IconClose, IconPencil } from '../components/nav/icons'
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import { StatusPill } from '../components/ui/StatusPill'
import { useAppStore, useScopedProperties } from '../store/useAppStore'
import { canEditList } from '../lib/leadLists'
import { distanceMiles, formatDistance } from '../lib/geo'
import { cityLine } from '../lib/format'

/**
 * One list: its houses, nearest first, and the way onto the map.
 *
 * Rows are plain rather than the swipeable lead row. The swipe on that row
 * starts a visit or a call, and next to a "Remove" control a horizontal
 * gesture is an accident waiting to happen; here a tap opens the lead and a
 * button, clearly labelled, takes it off the list. Nothing here changes the
 * lead itself — status and notes live on its page, one tap away.
 */
export function ListDetail() {
  const nav = useNavigate()
  const { listId } = useParams()
  const list = useAppStore((s) => (listId ? s.leadLists[listId] : undefined))
  const user = useAppStore((s) => s.user)
  const position = useAppStore((s) => s.position)
  const updateList = useAppStore((s) => s.updateList)
  const updateListMembers = useAppStore((s) => s.updateListMembers)
  const scoped = useScopedProperties()

  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editable = !!list && canEditList(user, list)

  const rows = useMemo(() => {
    if (!list) return []
    const ids = new Set(list.leadIds)
    const mine = scoped.filter((p) => ids.has(p.id))
    if (!position) return mine.sort((a, b) => a.address1.localeCompare(b.address1))
    return mine
      .map((p) => ({ p, d: distanceMiles(position, p) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.p)
  }, [list, scoped, position])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not change that.')
    } finally {
      setBusy(false)
    }
  }

  if (!list || list.archived) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TopBar title="List" back="/lists" />
        <div className="scroll-pane pad-nav bg-surface-sunk">
          <div className="content-col page">
            <p className="panel px-5 py-8 text-center text-[14px] text-ink-mute">
              This list is no longer here — it may have been archived or taken back by the office.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Houses on the list this phone cannot see: assigned to somebody else and not
  // on a list handed to this rep. Counted rather than hidden, so a short list
  // does not read as a short list.
  const unseen = list.leadIds.length - rows.length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title={list.name}
        subtitle={`${list.leadIds.length} lead${list.leadIds.length === 1 ? '' : 's'}${list.pending ? ' · syncing' : ''}`}
        back="/lists"
        right={
          editable ? (
            <button
              onClick={() => {
                setName(list.name)
                setRenaming((r) => !r)
              }}
              aria-label={renaming ? 'Cancel' : 'Edit list'}
              title={renaming ? 'Cancel' : 'Edit list'}
              data-testid="edit-list"
              className="icon-sm focusable grid min-h-[44px] w-11 place-items-center rounded-lg text-accent"
            >
              {renaming ? <IconClose /> : <IconPencil />}
            </button>
          ) : undefined
        }
      />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col page anim-rise">
          {list.description && (
            <p className="px-1 text-[13.5px] leading-relaxed text-ink-soft">{list.description}</p>
          )}

          {renaming && editable && (
            <section className="panel px-4 py-4" data-testid="list-edit">
              <Field label="Name" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy || !name.trim() || name.trim() === list.name}
                  onClick={() =>
                    void run(async () => {
                      await updateList(list.id, { name })
                      setRenaming(false)
                    })
                  }
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await updateList(list.id, { archived: true })
                      nav('/lists')
                    })
                  }
                >
                  Archive list
                </Button>
              </div>
              <p className="mt-2 text-[12.5px] text-ink-mute">
                Archiving puts the list away. The leads on it are untouched.
              </p>
            </section>
          )}

          {error && (
            <p role="alert" className="px-1 text-[13px] font-medium text-bad">
              {error}
            </p>
          )}

          <Button
            full
            size="lg"
            disabled={rows.length === 0}
            onClick={() => nav(`/map?list=${encodeURIComponent(list.id)}`)}
            data-testid="open-on-map"
          >
            {rows.length === 0 ? 'Nothing to show on the map yet' : 'Open on map'}
          </Button>

          {rows.length === 0 ? (
            <div className="panel px-5 py-8 text-center" data-testid="list-empty">
              <p className="text-[15px] font-semibold">No houses on this list yet</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-mute">
                {editable
                  ? 'Open any lead and tap “Add to list”, or tap a house on the map.'
                  : 'The office has not put anything on it yet.'}
              </p>
            </div>
          ) : (
            <ul className="panel divide-y divide-line-soft">
              {rows.map((p) => {
                const d = position ? distanceMiles(position, p) : null
                return (
                  <li key={p.id} className="flex items-center gap-2 pr-2">
                    <button
                      onClick={() => nav(`/property/${p.id}`)}
                      data-testid="list-lead"
                      className="flex min-h-[64px] min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left active:bg-surface-field"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-[15px] font-medium">{p.address1}</span>
                          {d != null && (
                            <span className="nums shrink-0 text-[12.5px] font-medium text-ink-mute">
                              {formatDistance(d)}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <StatusPill status={p.status} />
                          <span className="truncate text-[12.5px] text-ink-mute">{cityLine(p)}</span>
                        </span>
                      </span>
                    </button>
                    {editable && (
                      <button
                        disabled={busy}
                        onClick={() => void run(() => updateListMembers(list.id, { remove: [p.id] }))}
                        aria-label={`Remove ${p.address1} from ${list.name}`}
                        className="focusable min-h-[44px] shrink-0 rounded-lg px-2.5 text-[13px] font-semibold text-ink-mute active:bg-surface-field"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {unseen > 0 && (
            <p className="px-1 text-[12.5px] text-ink-mute">
              {unseen} more on this list {unseen === 1 ? 'is' : 'are'} not on your phone — assigned to
              someone else.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
