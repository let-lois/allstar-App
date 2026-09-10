import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore, useListsContaining, useMyLists } from '../../store/useAppStore'
import { canEditList } from '../../lib/leadLists'
import { Button } from '../ui/Button'
import { Field } from '../ui/Input'

/**
 * Which lists this house is on, and the control that changes it.
 *
 * On the peek and on the profile, so a rep standing at a door can put it on
 * tonight's re-knock list without leaving the door. Only lists the rep may
 * edit are offered — their own. A list the office handed them is shown, named,
 * and left alone: the server would refuse the change, and offering a control
 * that fails on tap is worse than not offering it.
 *
 * `compact` is the peek: one line of names and a single button, because the
 * sheet's opening detent has room for an address and one thing to press.
 */
export function ListMembership({ propertyId, compact }: { propertyId: string; compact?: boolean }) {
  const nav = useNavigate()
  const user = useAppStore((s) => s.user)
  const updateListMembers = useAppStore((s) => s.updateListMembers)
  const createList = useAppStore((s) => s.createList)
  const on = useListsContaining(propertyId)
  const mine = useMyLists()
  const editable = mine.filter((l) => canEditList(user, l))

  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not change that. Nothing was saved.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (listId: string, has: boolean) =>
    run(() => updateListMembers(listId, has ? { remove: [propertyId] } : { add: [propertyId] }))

  const create = () =>
    run(async () => {
      await createList({ name: newName, propertyIds: [propertyId] })
      setNewName('')
    })

  return (
    <div data-testid="list-membership">
      <div className="flex flex-wrap items-center gap-1.5">
        {!compact && <span className="text-[13px] font-medium text-ink-soft">On</span>}
        {on.length === 0 ? (
          <span className="text-[12.5px] text-ink-mute">{compact ? 'Not on a list' : 'No lists yet.'}</span>
        ) : (
          on.map((l) => (
            <button
              key={l.id}
              onClick={() => nav(`/lists/${l.id}`)}
              className="focusable rounded-full bg-ink/10 px-2.5 py-1 text-[12px] font-semibold text-accent-strong"
              data-testid="on-list"
            >
              {l.name}
            </button>
          ))
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="focusable ml-auto min-h-[36px] rounded-lg px-2 text-[13px] font-semibold text-accent"
        >
          {open ? 'Done' : 'Add to list'}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2 rounded-field bg-surface-sunk px-3 py-2.5" data-testid="list-picker">
          {editable.length === 0 ? (
            <p className="text-[12.5px] text-ink-mute">
              You have no lists of your own yet. Start one below — it stays on this phone until you’re back online.
            </p>
          ) : (
            <ul className="space-y-1">
              {editable.map((l) => {
                const has = l.leadIds.includes(propertyId)
                return (
                  <li key={l.id}>
                    <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[14px]">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-500"
                        checked={has}
                        disabled={busy}
                        onChange={() => void toggle(l.id, has)}
                      />
                      <span className="min-w-0 flex-1 truncate">{l.name}</span>
                      <span className="nums text-[12px] text-ink-mute">{l.leadIds.length}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <Field
              label="New list"
              value={newName}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Come back Saturday"
              className="min-w-0 flex-1"
            />
            <Button size="md" disabled={busy || !newName.trim()} onClick={() => void create()} className="mb-0.5">
              Create
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-[13px] font-medium text-bad">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
