import { IconArrowDown, IconArrowUp } from '../components/nav/icons'
import { Glyph } from '../components/ui/Glyph'
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
import { IntegrationsPanel } from './IntegrationsPanel'
import { GeocodingPanel } from './GeocodingPanel'
import { GoogleStatusPanel } from './GoogleStatusPanel'
import { ReportingPanel } from './ReportingPanel'
import { CompanyPanel } from './CompanyPanel'

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
  const [tab, setTab] = useState<
    'outcomes' | 'notes' | 'photos' | 'reporting' | 'integrations' | 'geocoding' | 'company'
  >('outcomes')

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
      {/*
        Scrolls inside itself rather than widening the page.

        This was a plain flex row, which was fine at three tabs and wrong at
        five: the row grew past the viewport and took the whole console with it,
        so dragging the tabs sideways panned the entire page and the last tab
        looked like it had fallen off the edge. The same `snap-x-row` the
        console's own top nav uses — a row that overflows must scroll in its own
        box, never in the document.
      */}
      <div className="snap-x-row mb-4 border-b border-line">
        {(
          [
            ['outcomes', 'Visit outcomes'],
            ['notes', 'Note templates'],
            ['photos', 'Photo categories'],
            ['reporting', 'Reporting'],
            ['integrations', 'Integrations'],
            ['geocoding', 'Address lookup'],
            ['company', 'Company'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`focusable -mb-px min-h-[40px] shrink-0 whitespace-nowrap border-b-2 px-4 text-sm font-semibold ${
              tab === key
                ? 'border-brand-500 text-accent'
                : 'border-transparent text-ink-mute hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'outcomes' && (
        <section className="overflow-hidden card">
          <div className="border-b border-line-soft px-5 py-3">
            <h2 className="text-sm font-bold">Visit outcomes</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">
              These are the buttons a rep taps after every knock. Order is the order they
              appear, and the first one gets the full-width target — keep the most
              frequent outcome at the top.
            </p>
          </div>
          {/*
            Scrolls rather than becoming cards, unlike the console's data
            screens. This is an editor: the "#" column is the order reps see,
            the arrows beside it move a row, and the value of the grid is that
            you can compare six outcomes' settings down a column. Cards would
            keep the data and lose the thing being edited. What it must not do
            is what it did — sit at 745px inside an `overflow-hidden` card,
            where "Visible" was off the right edge with no way to reach it.
          */}
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
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
                <tr key={o.code} className="border-t border-line-soft">
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
                        /* 44px on a phone. A 24px arrow is a cursor target;
                           reordering outcomes is exactly the kind of setup an
                           owner does once, often from a phone, and missing the
                           arrow moves the wrong row. */
                        className="icon-xs focusable grid h-11 w-11 place-items-center rounded text-ink-mute disabled:opacity-30 lg:h-6 lg:w-6"
                      >
                        <IconArrowUp />
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
                        /* 44px on a phone. A 24px arrow is a cursor target;
                           reordering outcomes is exactly the kind of setup an
                           owner does once, often from a phone, and missing the
                           arrow moves the wrong row. */
                        className="icon-xs focusable grid h-11 w-11 place-items-center rounded text-ink-mute disabled:opacity-30 lg:h-6 lg:w-6"
                      >
                        <IconArrowDown />
                      </button>
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-2">
                      <Glyph name={o.icon} className="icon-xs" />
                      <input
                        value={o.label}
                        onChange={(e) =>
                          setOutcomes((prev) =>
                            prev.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)),
                          )
                        }
                        className="focusable min-h-[44px] w-40 rounded-lg border border-line px-2 text-sm md:min-h-[36px]"
                      />
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <code className="rounded bg-surface-field px-1.5 py-0.5 text-xs text-ink-mute">
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
          </div>
          <div className="flex items-center justify-between border-t border-line-soft px-5 py-3">
            <p className="text-xs text-ink-mute">
              The code is permanent. Reports and pipeline rules key off it, so a renamed
              outcome keeps its history.
            </p>
            <SaveBar />
          </div>
        </section>
      )}

      {tab === 'notes' && (
        <section className="card p-5">
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
                  /*
                    `min-w-0` because `flex-1` alone does not let a flex child
                    shrink past its intrinsic width, and an input's is about
                    twenty characters. On a 320px screen the row refused to fit
                    and pushed the whole panel wider than the pane.
                  */
                  className="focusable min-h-[38px] min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
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
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
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
        <section className="card p-5">
          <h2 className="text-sm font-bold">Photo categories</h2>
          <p className="mb-4 mt-0.5 text-xs leading-relaxed text-ink-mute">
            Shown after a rep takes a shot. Keep this list short — it's a decision made
            one-handed, outdoors.
          </p>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {categories.map((c, i) => (
              <div
                key={c.key}
                className="flex items-center gap-2 rounded-field border border-line px-3 py-2.5"
              >
                {c.icon ? <Glyph name={c.icon} /> : <span aria-hidden>{c.letter}</span>}
                <input
                  value={c.label}
                  onChange={(e) =>
                    setCategories((prev) =>
                      prev.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)),
                    )
                  }
                  className="focusable min-h-[32px] min-w-0 flex-1 rounded-lg border border-transparent px-1 text-sm hover:border-line"
                />
              </div>
            ))}
          </div>
          <div className="mt-4">
            <SaveBar />
          </div>
        </section>
      )}

      {tab === 'company' && <CompanyPanel />}
      {tab === 'reporting' && <ReportingPanel />}
      {tab === 'integrations' && <IntegrationsPanel />}
      {tab === 'geocoding' && (
        /*
          Google's own status sits above the provider list, and outside
          `GeocodingPanel`, because the two answer different questions. That
          panel is about a company's account — which vendor turns their imported
          addresses into pins, billed to them — and it has nothing to show in
          demo mode. This is about the build in front of you: whether the key
          compiled into this bundle can draw a map, suggest an address and name
          the house under a rep's finger. That is true or false regardless of
          which company is signed in.
        */
        <>
          <GoogleStatusPanel />
          <GeocodingPanel />
        </>
      )}

      {/*
        The footer is about relabelling, which is what three of the four tabs
        do. It would be actively wrong under the integrations tab — nothing
        there is a label, and none of it reaches a rep's phone.
      */}
      {tab !== 'integrations' && tab !== 'reporting' && tab !== 'geocoding' && tab !== 'company' && (
      <p className="mt-4 rounded-field bg-surface-sunk px-4 py-3 text-xs leading-relaxed text-ink-mute">
        {mode === 'live'
          ? 'These are the words reps see. Codes never change, so renaming an outcome keeps every report and every pipeline rule intact — and a rep whose phone is offline keeps the last labels it synced.'
          : 'Demo data — there is nowhere to persist a change. Sign in with real credentials to configure a company.'}
      </p>
      )}
    </AdminPage>
  )
}
