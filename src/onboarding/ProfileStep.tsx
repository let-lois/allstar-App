import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import { AvatarPicker } from '../components/ui/AvatarPicker'
import * as db from '../lib/db'
import { ROLE_LABEL } from '../lib/roles'
import { useAppStore } from '../store/useAppStore'
import type { StepProps } from './steps'

/**
 * Step 1 — the profile. Only what is missing is asked for loudly.
 *
 * Whatever the admin typed when they added this person arrives filled in and
 * stays editable; whatever they did not is an empty field. The two that must
 * be filled to continue — first and last name — are the ones a badge is
 * printed with. Phone and title are offered, not required.
 *
 * Email, role and team are shown and locked: they are the admin's to change,
 * and a rep moving themselves to another office is not a feature.
 *
 * The photo is asked for here, through the same picker More uses, but it does
 * not block Continue: it goes up through the outbox, and the checklist at the
 * end holds completion for it. A rep in a stairwell should not be stuck on
 * step one because an upload is queued.
 *
 * Typing is drafted to the device as it happens. A connection dropping between
 * the last keystroke and Continue must not cost them the form.
 */
export function ProfileStep({ view, busy, error, post }: StepProps) {
  const user = useAppStore((s) => s.user)
  const draftKey = `allstar.onboarding.draft.${user?.id ?? 'anon'}`

  const [firstName, setFirstName] = useState(view.profile.firstName ?? '')
  const [lastName, setLastName] = useState(view.profile.lastName ?? '')
  const [phone, setPhone] = useState(view.profile.phone ?? '')
  const [jobTitle, setJobTitle] = useState(view.profile.jobTitle ?? '')
  const [localError, setLocalError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)

  useEffect(() => {
    let alive = true
    void db.metaGet<Record<string, string>>(draftKey).then((d) => {
      if (!alive || !d) {
        setRestored(true)
        return
      }
      // A draft only fills what the server left empty. What the admin typed,
      // or what was saved already, wins over a stale draft.
      if (!view.profile.firstName && d.firstName) setFirstName(d.firstName)
      if (!view.profile.lastName && d.lastName) setLastName(d.lastName)
      if (!view.profile.phone && d.phone) setPhone(d.phone)
      if (!view.profile.jobTitle && d.jobTitle) setJobTitle(d.jobTitle)
      setRestored(true)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  useEffect(() => {
    if (!restored) return
    void db.metaSet(draftKey, { firstName, lastName, phone, jobTitle })
  }, [restored, draftKey, firstName, lastName, phone, jobTitle])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!firstName.trim() || !lastName.trim()) {
      setLocalError('Your first and last name go on your badge, so both are needed.')
      return
    }
    setLocalError(null)
    const ok = await post('profile', {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: phone.trim(),
      jobTitle: jobTitle.trim(),
    })
    if (ok) void db.metaSet(draftKey, undefined)
  }

  const missingName = view.missing.includes('firstName') || view.missing.includes('lastName')

  return (
    <form onSubmit={submit} noValidate className="anim-rise">
      <p className="text-[15px] leading-relaxed text-ink-mute">
        {missingName
          ? 'A few details for your badge. Anything already filled in came from your admin — change it if it is wrong.'
          : 'Your admin filled most of this in. Check it, add a photo, and continue.'}
      </p>

      {/* --- the photo --------------------------------------------------- */}
      <div className="card mt-5 flex items-center gap-4 p-4" data-testid="profile-photo">
        <AvatarPicker />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">Profile photo</p>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-mute">
            {view.profile.hasPhoto || user?.avatarUrl
              ? 'Looks good. Tap it to change.'
              : 'Tap to add one. It goes on your badge and beside your name on the board.'}
          </p>
        </div>
      </div>

      {/* --- what they may change ---------------------------------------- */}
      <div className="mt-5 grid gap-4">
        <Field
          label="First name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          autoComplete="given-name"
          autoCapitalize="words"
          enterKeyHint="next"
          placeholder="Jordan"
          data-testid="profile-first"
        />
        <Field
          label="Last name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          autoComplete="family-name"
          autoCapitalize="words"
          enterKeyHint="next"
          placeholder="Vale"
          data-testid="profile-last"
        />
        <Field
          label="Phone (optional)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
          inputMode="tel"
          enterKeyHint="next"
          placeholder="(512) 555-0134"
          hint="So the office can reach you in the field."
        />
        <Field
          label="Job title (optional)"
          value={jobTitle}
          onChange={(e) => setJobTitle(e.target.value)}
          autoCapitalize="words"
          enterKeyHint="done"
          placeholder="Sales Representative"
          hint="Printed under your name on the badge."
        />
      </div>

      {/* --- what only the admin changes ---------------------------------- */}
      <dl className="card mt-5 divide-y divide-line-soft p-0" data-testid="profile-locked">
        <Locked label="Email" value={view.profile.email} />
        <Locked label="Role" value={user ? ROLE_LABEL[user.role] : ''} />
        {view.profile.teamName && <Locked label="Team / office" value={view.profile.teamName} />}
      </dl>
      <p className="mt-2 text-[12.5px] text-ink-mute">Set by your admin. Ask them if something here is wrong.</p>

      {(localError || error) && (
        <p role="alert" className="mt-4 rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad">
          {localError ?? error}
        </p>
      )}

      <Button type="submit" size="lg" full className="mt-6" disabled={busy}>
        {busy ? 'Saving…' : 'Continue'}
      </Button>
    </form>
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
