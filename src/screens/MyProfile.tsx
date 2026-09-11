import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import { AvatarPicker, AvatarRemove } from '../components/ui/AvatarPicker'
import { ApiError, apiUpdateProfile } from '../lib/http'
import { ROLE_LABEL } from '../lib/roles'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'

/**
 * Edit profile — the four things a person may change about themselves.
 *
 * The split is the same one onboarding drew and the server enforces: first
 * name, last name, phone and job title are theirs; email, role and team are
 * the admin's, shown here as facts so nobody hunts for a field that does not
 * exist. Saving goes straight to the server rather than through the outbox —
 * a name change is rare, it is what gets printed on a badge, and the person
 * wants to know it took.
 */
export function MyProfile() {
  const nav = useNavigate()
  const user = useAppStore((s) => s.user)
  const mode = useAppStore((s) => s.mode)
  const refreshMe = useAppStore((s) => s.refreshMe)
  const [firstName, setFirstName] = useState(user?.firstName ?? '')
  const [lastName, setLastName] = useState(user?.lastName ?? '')
  const [phone, setPhone] = useState(user?.phone ?? '')
  const [jobTitle, setJobTitle] = useState(user?.jobTitle ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  if (!user) return null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const token = liveToken()
    if (!token) return
    if (!firstName.trim() || !lastName.trim()) {
      setError('Your first and last name go on your badge, so both are needed.')
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await apiUpdateProfile(token, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
        jobTitle: jobTitle.trim(),
      })
      await refreshMe()
      setSaved(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save just now. Try again when you have signal.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Edit profile" back="/more" />
      <div className="scroll-pane pad-nav bg-surface-sunk">
        <form onSubmit={submit} noValidate className="content-col page anim-rise" data-testid="profile-form">
          <div className="card flex items-center gap-4 p-4">
            <AvatarPicker />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">Profile photo</p>
              <p className="mt-0.5 text-[13px] leading-snug text-ink-mute">On your badge and beside your name on the board.</p>
              <AvatarRemove />
            </div>
          </div>

          {mode === 'live' ? (
            <>
              <div className="mt-5 grid gap-4">
                <Field label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" autoCapitalize="words" data-testid="profile-first" />
                <Field label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" autoCapitalize="words" data-testid="profile-last" />
                <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" hint="So the office can reach you in the field." data-testid="profile-phone" />
                <Field label="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} autoCapitalize="words" hint="Printed under your name on the badge." data-testid="profile-title" />
              </div>

              <dl className="card mt-5 divide-y divide-line-soft p-0" data-testid="profile-locked">
                <Locked label="Email" value={user.email ?? ""} />
                <Locked label="Role" value={ROLE_LABEL[user.role]} />
                {user.teamName && <Locked label="Team / office" value={user.teamName} />}
              </dl>
              <p className="mt-2 text-[12.5px] text-ink-mute">Set by your admin. Ask them if something here is wrong.</p>

              {error && (
                <p role="alert" className="mt-4 rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad">{error}</p>
              )}
              {saved && !error && (
                <p role="status" className="mt-4 rounded-field bg-good-bg px-3 py-2.5 text-[14px] font-medium text-good" data-testid="profile-saved">
                  Saved. Your badge shows the change.
                </p>
              )}

              <Button type="submit" size="lg" full className="mt-6" disabled={busy} data-testid="profile-save">
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="secondary" full className="mt-3" onClick={() => nav('/badge')}>
                See my badge
              </Button>
            </>
          ) : (
            <p className="mt-5 text-[15px] leading-relaxed text-ink-mute">
              The demo account has no profile to edit. Sign in to your company account to change your name or title.
            </p>
          )}
        </form>
      </div>
    </div>
  )
}

function Locked({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <dt className="text-[13px] font-medium text-ink-mute">{label}</dt>
      <dd className="truncate text-[15px]">{value}</dd>
    </div>
  )
}
