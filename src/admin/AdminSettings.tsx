import { useEffect, useState } from 'react'
import { AdminPage } from './AdminLayout'
import { Button } from '../components/ui/Button'
import { ApiError, apiSaveSettings } from '../lib/http'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'
import {
  effectiveNoteTemplates,
  effectiveOutcomes,
  effectivePhotoCategories,
} from '../lib/settings'
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

  const stored = useAppStore((s) => s.settings)
  const mode = useAppStore((s) => s.mode)
  const user = useAppStore((s) => s.user)
  const refreshFromServer = useAppStore((s) => s.refreshFromServer)

  // Local edits, seeded from what the field app is currently using rather than
  // from the raw overrides — an admin should be editing the labels reps see.
  const [outcomes, setOutcomes] = useState(() => effectiveOutcomes(stored))
  const [templates, setTemplates] = useState(() => effectiveNoteTemplates(stored))
  const [categories, setCategories] = useState(() => effectivePhotoCategories(stored))
  useEffect(() => {
    setOutcomes(effectiveOutcomes(stored))
    setTemplates(effectiveNoteTemplates(stored))
    setCategories(effectivePhotoCategories(stored))
  }, [stored])

  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const token = liveToken()
    if (!token) {
      setError('Saving needs a live account. The demo has nowhere to persist a change.')
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await apiSaveSettings(token, {
        // Only label and order travel. Everything that carries meaning — the
        // code, the tone, whether an outcome prompts a follow-up — stays in the
        // source, so a rename can never rewrite what a year of history means.
        outcomes: outcomes.map((o, i) => ({ code: o.code, label: o.label, order: i })),
        noteTemplates: templates.map((t) => t.trim()).filter(Boolean),
        photoCategories: categories.map((c) => ({ key: c.key, label: c.label })),
      })
      await refreshFromServer()
      setNotice('Saved. Reps pick this up the next time their phone syncs.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Nothing was changed.')
    } finally {
      setSaving(false)
    }
  }

  const SaveBar = ({ children }: { children?: React.ReactNode }) => (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {children}
      {notice && <span className="text-xs font-medium text-good">{notice}</span>}
      {error && <span className="text-xs font-medium text-bad">{error}</span>}
      <Button size="sm" disabled={saving || mode !== 'live'} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  )

  return (
    <AdminPage
      title="Settings"
      description={`How the field app behaves for everyone at ${user?.clientName ?? 'your company'}`}
    >
      <div className="mb-4 flex gap-1 border-b border-ink/10">
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
        <section className="overflow-hidden rounded-card border border-ink/10 bg-surface">
          <div className="border-b border-ink/[0.06] px-5 py-3">
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
              {outcomes.map((o, i) => (
                <tr key={o.code} className="border-t border-ink/[0.06]">
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1">
                      <span className="nums w-4 text-ink-mute">{i + 1}</span>
                      {/* Order is the order reps see, and the first one gets the
                          full-width target — so moving a row is a real setting,
                          not a cosmetic one. */}
                      <button
                        aria-label={`Move ${o.label} up`}
                        disabled={i === 0}
                        onClick={() =>
                          setOutcomes((prev) => {
                            const next = [...prev]
                            ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                            return next
                          })
                        }
                        className="focusable h-6 w-6 rounded text-xs text-ink-mute disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`Move ${o.label} down`}
                        disabled={i === outcomes.length - 1}
                        onClick={() =>
                          setOutcomes((prev) => {
                            const next = [...prev]
                            ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
                            return next
                          })
                        }
                        className="focusable h-6 w-6 rounded text-xs text-ink-mute disabled:opacity-30"
                      >
                        ↓
                      </button>
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-2">
                      <span aria-hidden>{o.glyph}</span>
                      <input
                        value={o.label}
                        onChange={(e) =>
                          setOutcomes((prev) =>
                            prev.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)),
                          )
                        }
                        className="focusable min-h-[36px] w-40 rounded-lg border border-ink/10 px-2 text-sm"
                      />
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <code className="rounded bg-ink/[0.06] px-1.5 py-0.5 text-xs text-ink-mute">
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
          <div className="flex items-center justify-between border-t border-ink/[0.06] px-5 py-3">
            <p className="text-xs text-ink-mute">
              The code is permanent. Reports and pipeline rules key off it, so a renamed
              outcome keeps its history.
            </p>
            <SaveBar />
          </div>
        </section>
      )}

      {tab === 'notes' && (
        <section className="rounded-card border border-ink/10 bg-surface p-5">
          <h2 className="text-sm font-bold">Quick note templates</h2>
          <p className="mb-4 mt-0.5 text-xs leading-relaxed text-ink-mute">
            One tap instead of thirty characters. These appear above the note box in Visit
            Mode, in this order.
          </p>
          <ul className="space-y-2">
            {templates.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="nums w-6 text-xs text-ink-mute">{i + 1}</span>
                <input
                  value={t}
                  onChange={(e) =>
                    setTemplates((prev) => prev.map((x, xi) => (xi === i ? e.target.value : x)))
                  }
                  className="focusable min-h-[38px] flex-1 rounded-lg border border-ink/10 px-3 text-sm"
                />
                <button
                  onClick={() => setTemplates((prev) => prev.filter((_, xi) => xi !== i))}
                  className="focusable min-h-[38px] rounded-lg px-3 text-xs font-semibold text-bad hover:bg-bad-bg"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setTemplates((prev) => [...prev, ''])}
            >
              Add template
            </Button>
            <SaveBar />
          </div>
        </section>
      )}

      {tab === 'photos' && (
        <section className="rounded-card border border-ink/10 bg-surface p-5">
          <h2 className="text-sm font-bold">Photo categories</h2>
          <p className="mb-4 mt-0.5 text-xs leading-relaxed text-ink-mute">
            Shown after a rep takes a shot. Keep this list short — it's a decision made
            one-handed, outdoors.
          </p>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {categories.map((c, i) => (
              <div
                key={c.key}
                className="flex items-center gap-2 rounded-field border border-ink/10 px-3 py-2.5"
              >
                <span aria-hidden>{c.glyph}</span>
                <input
                  value={c.label}
                  onChange={(e) =>
                    setCategories((prev) =>
                      prev.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)),
                    )
                  }
                  className="focusable min-h-[32px] min-w-0 flex-1 rounded-lg border border-transparent px-1 text-sm hover:border-ink/10"
                />
              </div>
            ))}
          </div>
          <div className="mt-4">
            <SaveBar />
          </div>
        </section>
      )}

      <p className="mt-4 rounded-field bg-surface-sunk px-4 py-3 text-xs leading-relaxed text-ink-mute">
        {mode === 'live'
          ? 'These are the words reps see. Codes never change, so renaming an outcome keeps every report and every pipeline rule intact — and a rep whose phone is offline keeps the last labels it synced.'
          : 'Demo data — there is nowhere to persist a change. Sign in with real credentials to configure a company.'}
      </p>
    </AdminPage>
  )
}
