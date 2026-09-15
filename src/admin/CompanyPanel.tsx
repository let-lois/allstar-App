import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import { TeamBadge } from '../components/badge/TeamBadge'
import {
  ApiError,
  apiCreateTeam,
  apiDeleteTeam,
  apiDisableJoinCode,
  apiJoinLink,
  apiRenameTeam,
  apiRotateJoinCode,
  apiTeams,
  apiUpdateCompany,
  type JoinLinkDTO,
  type TeamDTO,
} from '../lib/http'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'

/**
 * Settings → Company: what the badge says about the company, and the two ways
 * people get in.
 *
 * Three things live here because they are all "the company, as a team member
 * sees it": the logo on every badge and the website its verification page
 * links to; the join link
 * that lets a rep who downloaded the app first create their own account; and
 * the teams/offices an admin sorts people into. None of it is a rep's to
 * change, which is why it is in the console and not in More.
 *
 * The join code is a credential for making field-rep accounts in this
 * company. Reading it is handing it out, so it is shown, not hidden — but
 * rotating it kills the old one in the same statement, and switching it off
 * is one tap. The link version carries the code so a rep types nothing.
 */

/** The server accepts a logo of at most this many bytes as a data URL. */
const LOGO_LIMIT = 64 * 1024
const LOGO_EDGE = 320

/** Shrink a picked image to a small PNG data URL the badge can carry offline. */
async function logoFromFile(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('That file is not an image the browser can read.'))
      el.src = url
    })
    const scale = Math.min(1, LOGO_EDGE / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not draw the image.')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    // PNG keeps a transparent background, which most logos have. If that is
    // too big, JPEG at a modest quality fits the limit for anything sane.
    let out = canvas.toDataURL('image/png')
    if (out.length > LOGO_LIMIT) out = canvas.toDataURL('image/jpeg', 0.8)
    if (out.length > LOGO_LIMIT) throw new Error('That logo is too detailed to fit on a badge. Try a simpler or smaller image.')
    return out
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function CompanyPanel() {
  const mode = useAppStore((s) => s.mode)
  const user = useAppStore((s) => s.user)
  const refreshMe = useAppStore((s) => s.refreshMe)
  const loadTeam = useAppStore((s) => s.loadTeam)

  const company: { name: string; timezone?: string; logoUrl?: string; website?: string; badgeQrUrl?: string } = user?.company ?? { name: user?.clientName ?? '' }
  const [website, setWebsite] = useState(company.website ?? '')
  const [badgeQr, setBadgeQr] = useState(company.badgeQrUrl ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [join, setJoin] = useState<JoinLinkDTO | null>(null)
  const [copied, setCopied] = useState(false)

  const [teams, setTeams] = useState<TeamDTO[] | null>(null)
  const [newTeam, setNewTeam] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    setWebsite(company.website ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.website])
  useEffect(() => {
    setBadgeQr(company.badgeQrUrl ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.badgeQrUrl])

  useEffect(() => {
    const token = liveToken()
    if (!token) return
    void apiJoinLink(token).then(setJoin).catch(() => setJoin(null))
    void apiTeams(token).then((r) => setTeams(r.teams)).catch(() => setTeams([]))
  }, [])

  async function run(label: string, fn: (token: string) => Promise<void>) {
    const token = liveToken()
    if (!token) {
      setError('Demo data — there is nowhere to save this. Sign in with real credentials to set up a company.')
      return
    }
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await fn(token)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'That didn’t work. Nothing was changed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="company-panel">
      <div className="space-y-6">
        {error && (
          <p role="alert" className="rounded-lg bg-bad-bg p-3 text-sm font-medium text-bad">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-lg bg-good-bg p-3 text-sm font-medium text-good">
            {notice}
          </p>
        )}

        {/* --- on the badge ---------------------------------------------- */}
        <section className="card p-4" data-testid="company-badge-details">
          <h3 className="text-sm font-bold">On every badge</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            The logo heads each team member’s badge. The QR code on every badge draws your company’s own QR link when you set one
            below; until then it opens the badge’s verification page, which shows the person, the company and whether the badge is
            still good. The website is linked from that page.
          </p>

          <div className="mt-4 flex items-center gap-4">
            {company.logoUrl ? (
              <img src={company.logoUrl} alt="Company logo" className="h-12 max-w-[160px] rounded-md bg-white object-contain p-1 ring-1 ring-line" data-testid="company-logo" />
            ) : (
              <div className="grid h-12 w-12 place-items-center rounded-md bg-surface-tint text-lg font-bold text-accent" aria-hidden="true">
                {company.name.trim().charAt(0).toUpperCase() || '?'}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="sr-only"
                data-testid="company-logo-file"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  void run('logo', async (token) => {
                    const logo = await logoFromFile(f)
                    await apiUpdateCompany(token, { logo })
                    await refreshMe()
                    setNotice('Logo saved. It is on every badge from now on.')
                  })
                }}
              />
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
                {busy === 'logo' ? 'Saving…' : company.logoUrl ? 'Replace logo' : 'Add logo'}
              </Button>
              {company.logoUrl && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  data-testid="company-logo-remove"
                  onClick={() =>
                    void run('logo-remove', async (token) => {
                      await apiUpdateCompany(token, { logo: null })
                      await refreshMe()
                      setNotice('Logo removed. Badges show the company’s initial instead.')
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
          <p className="mt-1.5 text-xs text-ink-mute">PNG or JPEG. It is shrunk to fit on a phone, so a simple mark works best.</p>

          <div className="mt-4 flex items-end gap-2">
            <div className="flex-1">
              <Field
                label="Company website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                inputMode="url"
                autoCapitalize="none"
                placeholder="ridgelineroofing.com"
                hint="Linked from the badge’s verification page. Optional; https is assumed."
                data-testid="company-website"
              />
            </div>
            <Button
              disabled={busy !== null || website.trim() === (company.website ?? '')}
              data-testid="company-website-save"
              onClick={() =>
                void run('website', async (token) => {
                  const next = website.trim()
                  await apiUpdateCompany(token, { website: next || null })
                  await refreshMe()
                  setNotice(next ? 'Website saved. Verification pages link to it from now on.' : 'Website cleared. Verification pages no longer link anywhere.')
                })
              }
            >
              {busy === 'website' ? 'Saving…' : 'Save'}
            </Button>
          </div>

          <div className="mt-4 flex items-end gap-2">
            <div className="flex-1">
              <Field
                label="Badge QR code link"
                value={badgeQr}
                onChange={(e) => setBadgeQr(e.target.value)}
                inputMode="url"
                autoCapitalize="none"
                placeholder="https://link.yourcompany.com/qr/…"
                hint="In the company’s GoHighLevel sub-account, open Sites → QR Codes, take the latest code and paste the link it points to. Every badge then draws that same code, and its scans count there. Leave empty to keep the badge’s verification page."
                data-testid="company-badge-qr"
              />
            </div>
            <Button
              disabled={busy !== null || badgeQr.trim() === (company.badgeQrUrl ?? '')}
              data-testid="company-badge-qr-save"
              onClick={() =>
                void run('badge-qr', async (token) => {
                  const next = badgeQr.trim()
                  await apiUpdateCompany(token, { badgeQrUrl: next || null })
                  await refreshMe()
                  setNotice(next ? 'Badge QR link saved. Every badge now draws your company’s code.' : 'Badge QR link cleared. Badges draw a code to their own verification page.')
                })
              }
            >
              {busy === 'badge-qr' ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </section>

        {/* --- the join link ---------------------------------------------- */}
        <section className="card p-4" data-testid="company-join">
          <h3 className="text-sm font-bold">Self sign-up</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            A rep who installs the app before you add them can create their own account with this code. It makes field-rep accounts
            only, in this company only, and it is a credential: share it with people you are hiring, and change it when you stop.
          </p>
          {mode !== 'live' ? (
            <p className="mt-3 text-xs text-ink-mute">Demo data — a real company has its own code here.</p>
          ) : join === null ? (
            <p className="mt-3 text-xs text-ink-mute">Loading…</p>
          ) : join.code ? (
            <div className="mt-3 rounded-lg bg-surface-sunk p-3 ring-1 ring-line">
              <p className="text-xs text-ink-mute">Company code</p>
              <p className="nums mt-0.5 text-[22px] font-bold tracking-[0.18em]" data-testid="join-code">
                {join.code.slice(0, 4)} {join.code.slice(4)}
              </p>
              {join.url && (
                <p className="mt-2 break-all font-mono text-xs" data-testid="join-url">
                  {join.url}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(join.url ?? join.code ?? '')
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    } catch {
                      /* the link is on screen and selectable */
                    }
                  }}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  data-testid="join-rotate"
                  onClick={() =>
                    void run('rotate', async (token) => {
                      setJoin(await apiRotateJoinCode(token))
                      setNotice('New code. The old one stopped working the moment this was saved; anyone still holding it needs the new one.')
                    })
                  }
                >
                  {busy === 'rotate' ? 'Changing…' : 'Change code'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  data-testid="join-disable"
                  onClick={() =>
                    void run('disable', async (token) => {
                      await apiDisableJoinCode(token)
                      setJoin({ code: null })
                      setNotice('Self sign-up is off. New people join by invitation only until you turn it back on.')
                    })
                  }
                >
                  {busy === 'disable' ? 'Turning off…' : 'Turn off'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-sm font-medium" data-testid="join-off">
                Off — people join by invitation only.
              </p>
              <Button
                size="sm"
                disabled={busy !== null}
                data-testid="join-enable"
                onClick={() =>
                  void run('rotate', async (token) => {
                    setJoin(await apiRotateJoinCode(token))
                    setNotice('Self sign-up is on. Share the code or the link with the people you are bringing on.')
                  })
                }
              >
                {busy === 'rotate' ? 'Turning on…' : 'Turn on'}
              </Button>
            </div>
          )}
        </section>

        {/* --- teams / offices -------------------------------------------- */}
        <section className="card p-4" data-testid="company-teams">
          <h3 className="text-sm font-bold">Teams and offices</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            How the roster is grouped and what a badge says under the company. Deleting a team takes nobody with it — its people are
            simply on no team until you move them.
          </p>
          {mode !== 'live' ? (
            <p className="mt-3 text-xs text-ink-mute">Demo data — a real company keeps its offices here.</p>
          ) : (
            <>
              <ul className="mt-3 divide-y divide-line-soft" data-testid="team-list">
                {(teams ?? []).map((t) => (
                  <li key={t.id} className="flex min-h-[44px] items-center gap-2 py-1.5" data-testid="team-row" data-team={t.name}>
                    {renaming?.id === t.id ? (
                      <>
                        <input
                          value={renaming.name}
                          onChange={(e) => setRenaming({ id: t.id, name: e.target.value })}
                          autoFocus
                          data-testid="team-rename-input"
                          className="focusable h-10 flex-1 rounded-lg border border-ink/15 px-3 text-sm"
                        />
                        <Button
                          size="sm"
                          disabled={busy !== null || !renaming.name.trim()}
                          data-testid="team-rename-save"
                          onClick={() =>
                            void run('rename', async (token) => {
                              const r = await apiRenameTeam(token, t.id, renaming.name.trim())
                              setTeams((list) => (list ?? []).map((x) => (x.id === t.id ? r : x)))
                              setRenaming(null)
                              void loadTeam()
                              setNotice(`Renamed to ${r.name}. Every badge and roster row follows.`)
                            })
                          }
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setRenaming(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
                        <span className="text-xs text-ink-mute">{t.memberCount === 1 ? '1 person' : `${t.memberCount} people`}</span>
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setRenaming({ id: t.id, name: t.name })}>
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="text-bad"
                          disabled={busy !== null}
                          onClick={() =>
                            void run('delete-team', async (token) => {
                              await apiDeleteTeam(token, t.id)
                              setTeams((list) => (list ?? []).filter((x) => x.id !== t.id))
                              void loadTeam()
                              setNotice(`${t.name} deleted. Anyone on it is now on no team.`)
                            })
                          }
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </li>
                ))}
                {teams !== null && teams.length === 0 && <li className="py-2 text-sm text-ink-mute">No teams yet.</li>}
              </ul>
              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = newTeam.trim()
                  if (!name) return
                  void run('add-team', async (token) => {
                    const r = await apiCreateTeam(token, name)
                    setTeams((list) => [...(list ?? []), r].sort((a, b) => a.name.localeCompare(b.name)))
                    setNewTeam('')
                    setNotice(`${r.name} added.`)
                  })
                }}
              >
                <input
                  value={newTeam}
                  onChange={(e) => setNewTeam(e.target.value)}
                  placeholder="New team or office, e.g. Austin"
                  autoCapitalize="words"
                  data-testid="team-new"
                  className="focusable h-11 flex-1 rounded-lg border border-ink/15 px-3 text-sm"
                />
                <Button type="submit" variant="secondary" disabled={busy !== null || !newTeam.trim()} data-testid="team-add">
                  {busy === 'add-team' ? 'Adding…' : 'Add team'}
                </Button>
              </form>
            </>
          )}
        </section>
      </div>

      {/* --- how it looks -------------------------------------------------- */}
      <aside className="lg:sticky lg:top-4 lg:self-start" data-testid="company-preview">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">How a badge looks</p>
        <TeamBadge
          badge={{ id: '12345678', status: 'active', issuedAt: Date.now(), expiresAt: Date.now() + 365 * 86_400_000, confirmedAt: Date.now() }}
          name={user?.name ?? 'Team member'}
          title="Sales Representative"
          company={{ ...company, website: website.trim() || undefined, badgeQrUrl: badgeQr.trim() || undefined }}
          avatarInitials={user?.avatarInitials ?? 'TM'}
          avatarUrl={user?.avatarUrl}
        />
        <p className="mt-2 text-xs leading-relaxed text-ink-mute">
          A sample — your own name, a sample id. {badgeQr.trim() ? 'Its QR code is your company’s link, as typed above.' : 'Scanning a real badge opens its verification page.'}
        </p>
      </aside>
    </div>
  )
}
