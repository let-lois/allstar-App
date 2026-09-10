import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { Field, TextArea } from '../components/ui/Input'
import { IconChevron } from '../components/nav/icons'
import { useAppStore, useMyLists } from '../store/useAppStore'

/**
 * My lists.
 *
 * Two kinds of list arrive here and they read the same: one the office drew
 * round a block and handed over, and one the rep made themselves from doors
 * they were already standing at. Each is a working set — a name, a count, and
 * a way onto the map — and a rep's day is often one of them.
 *
 * Starting a list here makes an empty one. Houses are added from the door —
 * the peek and the profile carry the control — because that is where a rep
 * decides a house belongs on tonight's list, not from a screen with no house
 * on it.
 */
export function Lists() {
  const nav = useNavigate()
  const lists = useMyLists()
  const user = useAppStore((s) => s.user)
  const team = useAppStore((s) => s.team)
  const createList = useAppStore((s) => s.createList)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (createdBy?: string) => {
    if (!createdBy || createdBy === user?.id) return null
    return team.find((m) => m.id === createdBy)?.name ?? 'the office'
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await createList({ name, description: description.trim() || undefined })
      setName('')
      setDescription('')
      setCreating(false)
      nav(`/lists/${made.id}`)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not create the list.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title="Lists"
        subtitle={`${lists.length} list${lists.length === 1 ? '' : 's'}`}
        back="/leads"
        right={
          <button
            onClick={() => setCreating((c) => !c)}
            className="focusable min-h-[44px] rounded-lg px-3 text-[14px] font-semibold text-accent"
          >
            {creating ? 'Cancel' : 'New list'}
          </button>
        }
      />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col page anim-rise">
          {creating && (
            <section className="panel px-4 py-4" data-testid="new-list-form">
              <div className="space-y-3">
                <Field
                  label="Name"
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Come back Saturday"
                  autoFocus
                />
                <TextArea
                  label="Description"
                  rows={2}
                  value={description}
                  disabled={busy}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional — what this list is for"
                />
                {error && (
                  <p role="alert" className="text-[13px] font-medium text-bad">
                    {error}
                  </p>
                )}
                <Button full disabled={busy || !name.trim()} onClick={() => void create()}>
                  {busy ? 'Creating…' : 'Create list'}
                </Button>
                <p className="text-[12.5px] leading-snug text-ink-mute">
                  Add houses from any lead’s page, or from the map. Works offline — it uploads
                  when you reconnect.
                </p>
              </div>
            </section>
          )}

          {lists.length === 0 && !creating ? (
            <div className="panel px-5 py-8 text-center" data-testid="lists-empty">
              <p className="text-[16px] font-semibold">No lists yet</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-mute">
                Your manager can hand you one, or start your own — a block to re-knock, doors to
                come back to on Saturday.
              </p>
              <Button variant="secondary" className="mt-4" onClick={() => setCreating(true)}>
                Start a list
              </Button>
            </div>
          ) : (
            <ul className="panel divide-y divide-line-soft">
              {lists.map((l) => {
                const who = from(l.createdBy)
                return (
                  <li key={l.id}>
                    <button
                      onClick={() => nav(`/lists/${l.id}`)}
                      data-testid="list-row"
                      className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-field"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">{l.name}</span>
                        <span className="block truncate text-[12.5px] text-ink-mute">
                          {[
                            `${l.leadIds.length} lead${l.leadIds.length === 1 ? '' : 's'}`,
                            who ? `from ${who}` : null,
                            l.pending ? 'syncing' : null,
                            l.description,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <IconChevron />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
