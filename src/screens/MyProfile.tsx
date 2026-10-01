import { useState } from 'react'
import { describeError } from '../lib/errors'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import { BottomSheet } from '../components/ui/BottomSheet'
import { AvatarPicker, AvatarRemove } from '../components/ui/AvatarPicker'
import { apiDeleteAccount, apiUpdateProfile } from '../lib/http'
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
      setError(describeError(err, 'Could not save just now. Try again when you have signal.'))
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
        {mode === 'live' && <DeleteAccount />}
      </div>
    </div>
  )
}

/*
  Delete my account. Apple requires it of any app that lets people make an
  account (guideline 5.1.1(v)), and it has to be findable, not hidden behind
  an email to support. It asks for the password and a typed DELETE, says
  exactly what goes and what stays, and signs out when it is done.
*/
function DeleteAccount() {
  const nav = useNavigate()
  const signOut = useAppStore((s) => s.signOut)
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    const token = liveToken()
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      await apiDeleteAccount(token, { password, confirm: confirm.trim().toUpperCase() })
      await signOut()
      nav('/', { replace: true })
    } catch (err) {
      setError(describeError(err, 'Could not delete the account just now. Try again when you have signal.'))
      setBusy(false)
    }
  }

  return (
    <div className="content-col px-4 pb-8">
      <div className="card mt-6 p-4" id="delete-account" data-testid="delete-account">
        <p className="text-[15px] font-semibold">Delete account</p>
        <p className="mt-1 text-[13px] leading-snug text-ink-mute">
          Permanently removes your sign-in, profile, badge and your own visits and notes. Leads you worked stay with your company.
        </p>
        <Button type="button" variant="danger" full className="mt-3" onClick={() => setOpen(true)} data-testid="delete-account-open">
          Delete my account
        </Button>
      </div>
      <BottomSheet open={open} onClose={() => !busy && setOpen(false)} title="Delete your account?">
        <div className="space-y-4 px-4 pb-6" data-testid="delete-account-sheet">
          <p className="text-[14px] leading-relaxed text-ink-soft">
            This cannot be undone. Your sign-in, profile, badge, and the visits, notes and photos you recorded are deleted. The leads you worked stay with your company and go back to its unassigned list.
          </p>
          <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="delete-account-password" />
          <Field label="Type DELETE to confirm" autoCapitalize="characters" autoCorrect="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="delete-account-confirm" />
          {error && <p role="alert" className="rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad">{error}</p>}
          <Button
            type="button"
            variant="danger"
            size="lg"
            full
            disabled={busy || !password || confirm.trim().toUpperCase() !== 'DELETE'}
            onClick={() => void remove()}
            data-testid="delete-account-submit"
          >
            {busy ? 'Deleting…' : 'Delete my account'}
          </Button>
        </div>
      </BottomSheet>
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
