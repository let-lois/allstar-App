import { useState } from 'react'
import { AdminPage } from './AdminLayout'
import { Button } from '../components/ui/Button'
import { OUTCOMES, NOTE_TEMPLATES, PHOTO_CATEGORIES } from '../data/outcomes'
import { STATUS } from './charts/tokens'

/**
 * Client configuration.
 *
 * This screen exists because the field app already promises it: the outcome
 * grid ships a default set with a comment saying Client Admins will be able to
 * relabel and reorder them, and the note composer says the same about
 * templates. Configuration lives here rather than on a phone — it is set up
 * once, by one person, sitting down.
 *
 * The `code` behind each outcome is fixed and shown: reporting and pipeline
 * rules key off it, so relabelling "Interested" to "Warm" must not silently
 * break a year of history.
 */
export function AdminSettings() {
  const [tab, setTab] = useState<'outcomes' | 'notes' | 'photos'>('outcomes')

  return (
    <AdminPage
      title="Settings"
      description="How the field app behaves for everyone at Summit Exteriors"
    >
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {(
          [
            ['outcomes', 'Visit outcomes'],
            ['notes', 'Note templates'],
            ['photos', 'Photo categories'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`focusable -mb-px min-h-[40px] border-b-2 px-4 text-sm font-semibold ${
              tab === key
                ? 'border-brand-500 text-brand-600'
                : 'border-transparent text-ink-mute hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'outcomes' && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-surface">
          <div className="border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-bold">Visit outcomes</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">
              These are the buttons a rep taps after every knock. Order is the order they
              appear, and the first one gets the full-width target — keep the most
              frequent outcome at the top.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface-sunk text-xs text-ink-mute">
              <tr>
                <th className="w-12 px-5 py-2.5 text-left font-semibold">#</th>
                <th className="px-3 py-2.5 text-left font-semibold">Label</th>
                <th className="px-3 py-2.5 text-left font-semibold">Code</th>
                <th className="px-3 py-2.5 text-left font-semibold">Moves lead to</th>
                <th className="px-3 py-2.5 text-left font-semibold">Prompts follow-up</th>
                <th className="px-5 py-2.5 text-left font-semibold">Visible</th>
              </tr>
            </thead>
            <tbody>
              {OUTCOMES.map((o, i) => (
                <tr key={o.code} className="border-t border-slate-100">
                  <td className="nums px-5 py-3 text-ink-mute">{i + 1}</td>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-2">
                      <span aria-hidden>{o.glyph}</span>
                      <input
                        defaultValue={o.label}
                        className="focusable min-h-[36px] w-40 rounded-lg border border-slate-200 px-2 text-sm"
                      />
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-ink-mute">
                      {o.code}
                    </code>
                  </td>
                  <td className="px-3 py-3 text-ink-mute">
                    {o.terminal ? 'Closes the lead' : o.promptsFollowUp ? 'Advances' : 'No change'}
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-xs">{o.promptsFollowUp ? 'Yes' : 'No'}</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                      <span
                        aria-hidden
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: STATUS.good }}
                      />
                      Shown
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
            <p className="text-xs text-ink-mute">
              The code is permanent. Reports and pipeline rules key off it, so a renamed
              outcome keeps its history.
            </p>
            <Button size="sm" disabled>
              Save changes
            </Button>
          </div>
        </section>
      )}

      {tab === 'notes' && (
        <section className="rounded-2xl border border-slate-200 bg-surface p-5">
          <h2 className="text-sm font-bold">Quick note templates</h2>
          <p className="mb-4 mt-0.5 text-xs leading-relaxed text-ink-mute">
            One tap instead of thirty characters. These appear above the note box in Visit
            Mode, in this order.
          </p>
          <ul className="space-y-2">
            {NOTE_TEMPLATES.map((t, i) => (
              <li key={t} className="flex items-center gap-2">
                <span className="nums w-6 text-xs text-ink-mute">{i + 1}</span>
                <input
                  defaultValue={t}
                  className="focusable min-h-[38px] flex-1 rounded-lg border border-slate-200 px-3 text-sm"
                />
                <button className="focusable min-h-[38px] rounded-lg px-3 text-xs font-semibold text-red-600 hover:bg-red-50">
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between">
            <Button size="sm" variant="secondary" disabled>
              Add template
            </Button>
            <Button size="sm" disabled>
              Save changes
            </Button>
          </div>
        </section>
      )}

      {tab === 'photos' && (
        <section className="rounded-2xl border border-slate-200 bg-surface p-5">
          <h2 className="text-sm font-bold">Photo categories</h2>
          <p className="mb-4 mt-0.5 text-xs leading-relaxed text-ink-mute">
            Shown after a rep takes a shot. Keep this list short — it's a decision made
            one-handed, outdoors.
          </p>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {PHOTO_CATEGORIES.map((c) => (
              <div
                key={c.key}
                className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5"
              >
                <span aria-hidden>{c.glyph}</span>
                <input
                  defaultValue={c.label}
                  className="focusable min-h-[32px] min-w-0 flex-1 rounded-lg border border-transparent px-1 text-sm hover:border-slate-200"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <Button size="sm" disabled>
              Save changes
            </Button>
          </div>
        </section>
      )}

      <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
        Saving is disabled until the backend lands. These controls show the shape of the
        configuration and read from the same source the field app uses, so what you see
        here is genuinely what reps get — but there is nowhere to persist a change yet,
        and a Save button that quietly does nothing is worse than one that's honestly off.
      </p>
    </AdminPage>
  )
}
