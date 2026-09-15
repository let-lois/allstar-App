import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What the onboarding facts mean — the ranking, pinned.
 *
 * Every status the console shows about a person is derived from timestamps
 * on their row, and the derivations have an order. "Accepted" must beat
 * "revoked" (a used invitation was used); "expired" must beat "awaiting
 * confirmation" (a badge past its date needs renewing, not confirming); a
 * completed onboarding at an old version must read as *required*, not
 * *complete*, or the one planned way of asking everyone again does nothing.
 *
 * None of this needs a database, so none of it gets one: the module is
 * bundled and the functions are called with rows written by hand, at a clock
 * this file controls.
 */

const out = join(mkdtempSync(join(tmpdir(), 'onb-')), 'onboarding.mjs')
await build({ entryPoints: ['src/onboarding.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
const {
  ONBOARDING_VERSION, BADGE_VALID_DAYS, ONBOARDING_STEPS,
  displayName, onboardingStatus, badgeStatus, invitationStatus, mintBadgeId,
  checklistFor, canComplete, nextStep, resumeStep,
} = await import(out)

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0)
const DAY = 86_400_000
const row = (over = {}) => ({
  name: 'Jordan Vale', first_name: null, last_name: null,
  onboarding_step: null, onboarding_version: 0, onboarding_completed_at: null,
  badge_id: null, badge_expires_at: null, badge_confirmed_at: null,
  ...over,
})

/* --- the constants are what the brief says ---------------------------------- */
ok(BADGE_VALID_DAYS === 365, 'a badge is good for one year by default — the brief’s number; change it deliberately', `${BADGE_VALID_DAYS}`)
ok(ONBOARDING_VERSION >= 1, 'the flow has a version', `${ONBOARDING_VERSION}`)
ok(
  ONBOARDING_STEPS.join(',') === 'profile,setup,walkthrough,badge,checklist',
  'the steps are the five the brief names, in the order a rep meets them',
  ONBOARDING_STEPS.join(' → '),
)
/*
  Migration 019 backfills existing accounts as having completed version 1 — a
  literal, because a migration is frozen history. This checks the literal is
  still 1 (nobody "helpfully" made it read the constant) and that the constant
  has not gone *below* it, which would make the backfilled rows look ahead of
  the flow.
*/
{
  const migrate = readFileSync('src/migrate.ts', 'utf8')
  ok(/onboarding_version = 1\b/.test(migrate), 'the backfill writes the literal version 1, not the moving constant')
  ok(ONBOARDING_VERSION >= 1, 'and the current version is at least that')
}

/* --- the display name ------------------------------------------------------- */
ok(displayName({ first_name: 'Jordan', last_name: 'Vale' }) === 'Jordan Vale', 'first and last make the name')
ok(displayName({ first_name: ' Jordan ', last_name: null, name: 'ignored' }) === 'Jordan', 'one half alone is used, trimmed', displayName({ first_name: ' Jordan ', last_name: null, name: 'ignored' }))
ok(displayName({ name: 'Legacy Name' }) === 'Legacy Name', 'an account from before the split keeps its stored name')
ok(displayName({ name: '', email: 'sam.ortiz@example.com' }) === 'sam.ortiz', 'a person added by email alone shows the part before the @ rather than a blank', displayName({ name: '', email: 'sam.ortiz@example.com' }))
ok(displayName({}) === '', 'and nothing at all is an empty string, which the status logic treats as missing')

/* --- onboarding: the four states and their ranking ------------------------- */
ok(onboardingStatus(row(), NOW) === 'not_started', 'no step and no completion is not started')
ok(onboardingStatus(row({ onboarding_step: 'setup' }), NOW) === 'in_progress', 'a step reached and no completion is in progress')
ok(
  onboardingStatus(row({ onboarding_step: 'checklist', onboarding_completed_at: NOW - DAY, onboarding_version: ONBOARDING_VERSION }), NOW) === 'complete',
  'completed at the current version is complete',
)
ok(
  onboardingStatus(row({ onboarding_completed_at: NOW - DAY, onboarding_version: ONBOARDING_VERSION - 1 }), NOW) === 'required',
  'completed at an OLDER version is required again — this is how a future version asks everyone',
)
ok(
  onboardingStatus(row({ onboarding_completed_at: NOW - DAY, onboarding_version: ONBOARDING_VERSION, name: '', first_name: null, last_name: null }), NOW) === 'required',
  'completed but with no name at all is required — a badge cannot be blank',
)
ok(
  onboardingStatus(row({ onboarding_step: 'badge', onboarding_completed_at: null, onboarding_version: ONBOARDING_VERSION }), NOW) === 'in_progress',
  'the version alone never completes anyone; only the completion timestamp does',
)
/*
  The backfilled shape, exactly as migration 019 leaves it: completed_at set,
  version 1, a stored name, no first/last, no photo, no badge. It has to read
  as complete — otherwise every existing rep is thrown into the flow on their
  next sign-in, which is the outcome the backfill exists to prevent.
*/
ok(
  onboardingStatus(row({ onboarding_completed_at: 1_700_000_000_000, onboarding_version: 1, name: 'Old Hand' }), NOW) === 'complete',
  'an account backfilled by migration 019 is complete, with no photo and no badge',
)

/* --- badge ------------------------------------------------------------------ */
ok(badgeStatus(row(), NOW) === 'none', 'no badge id is none')
ok(badgeStatus(row({ badge_id: '32143567', badge_expires_at: NOW + 300 * DAY }), NOW) === 'awaiting_confirmation', 'minted and unconfirmed awaits confirmation')
ok(badgeStatus(row({ badge_id: '32143567', badge_expires_at: NOW + 300 * DAY, badge_confirmed_at: NOW - DAY }), NOW) === 'active', 'confirmed and in date is active')
ok(badgeStatus(row({ badge_id: '32143567', badge_expires_at: NOW - 1, badge_confirmed_at: NOW - 400 * DAY }), NOW) === 'expired', 'a confirmed badge past its date is expired')
ok(
  badgeStatus(row({ badge_id: '32143567', badge_expires_at: NOW - 1, badge_confirmed_at: null }), NOW) === 'expired',
  'expired outranks unconfirmed — the fix is a renewal, not a confirmation',
)
ok(badgeStatus(row({ badge_id: '32143567', badge_expires_at: NOW, badge_confirmed_at: NOW - DAY }), NOW) === 'expired', 'the expiry instant itself is expired, so the boundary is not off by one')

/* --- invitation ------------------------------------------------------------- */
ok(invitationStatus(null, NOW) === 'not_sent', 'no token ever is not sent')
ok(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: NOW + DAY }, NOW) === 'pending', 'a live token is pending')
ok(invitationStatus({ accepted_at: NOW - DAY, revoked_at: null, expires_at: NOW - 1 }, NOW) === 'accepted', 'accepted stays accepted after the token would have expired')
ok(invitationStatus({ accepted_at: NOW - DAY, revoked_at: NOW, expires_at: NOW + DAY }, NOW) === 'accepted', 'accepted beats revoked — a used invitation was used')
ok(invitationStatus({ accepted_at: null, revoked_at: NOW - DAY, expires_at: NOW - 1 }, NOW) === 'revoked', 'revoked beats expired — it records a decision, not a calendar')
ok(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: NOW }, NOW) === 'expired', 'the expiry instant is expired')
ok(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: NOW + DAY, opened_at: NOW - 60_000 }, NOW) === 'opened', 'a live link that was opened reads opened')
ok(invitationStatus({ accepted_at: null, revoked_at: NOW, expires_at: NOW + DAY, opened_at: NOW - 60_000 }, NOW) === 'revoked', 'revoked beats opened — the admin cancelled it after they saw it')
ok(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: NOW - 1, opened_at: NOW - DAY }, NOW) === 'expired', 'expired beats opened — they saw it and let it lapse')
ok(invitationStatus({ accepted_at: NOW, revoked_at: null, expires_at: NOW + DAY, opened_at: NOW - 60_000 }, NOW) === 'accepted', 'accepted beats opened')

/* --- the badge id ----------------------------------------------------------- */
{
  const ids = Array.from({ length: 200 }, () => mintBadgeId())
  ok(ids.every((id) => /^[1-9]\d{7}$/.test(id)), 'a badge id is eight digits and never starts with a zero', ids[0])
  const zeros = mintBadgeId(() => 0)
  ok(/^[1-9]0{7}$/.test(zeros), 'a run of zeros still gets a non-zero first digit', zeros)
  ok(new Set(ids).size > 190, 'two hundred mints are nearly all distinct — uniqueness is enforced by the database, but the space is wide', `${new Set(ids).size} distinct`)
}

/* --- the checklist: what is required, and what merely helps ---------------- */
{
  const full = {
    ...row({ first_name: 'Jordan', last_name: 'Vale', badge_id: '32143567', badge_expires_at: NOW + 300 * DAY, badge_confirmed_at: NOW - DAY }),
    avatar_url: 'data:image/jpeg;base64,x', location_status: 'granted', notification_status: 'granted', walkthrough_completed_at: NOW - DAY, role: 'field_rep', team_name: 'Austin',
  }
  const items = checklistFor(full, NOW)
  ok(items.length === 8, 'the checklist has the brief’s eight lines, notifications included', `${items.length}`)
  ok(items.every((i) => i.done), 'everything done reads as done')
  ok(canComplete(items), 'and can complete')

  const noNotif = checklistFor({ ...full, notification_status: 'denied' }, NOW)
  ok(!noNotif.find((i) => i.key === 'notifications_enabled').done, 'refused notifications are not done')
  ok(canComplete(noNotif) && !noNotif.find((i) => i.key === 'notifications_enabled').required, 'but do NOT block completion — recommended, like location')
  ok(/launch/i.test(noNotif.find((i) => i.key === 'notifications_enabled').detail ?? ''), 'and the line is honest that reminders have not launched yet')
  const neverAsked = checklistFor({ ...full, notification_status: null }, NOW)
  ok(!neverAsked.find((i) => i.key === 'notifications_enabled').done && canComplete(neverAsked), 'a phone from before the card existed reads not done, and still completes')

  const denied = checklistFor({ ...full, location_status: 'denied' }, NOW)
  ok(!denied.find((i) => i.key === 'location_enabled').done, 'a denied location is not done')
  ok(canComplete(denied), 'but does NOT block completion — a rep who denied location can still knock', denied.find((i) => i.key === 'location_enabled').required ? 'required' : 'recommended')
  ok(/map/i.test(denied.find((i) => i.key === 'location_enabled').detail ?? ''), 'and the line says what is lost')

  const noPhoto = checklistFor({ ...full, avatar_url: null }, NOW)
  ok(!canComplete(noPhoto), 'no photo blocks completion — the badge would show initials', noPhoto.find((i) => i.key === 'photo_added').required ? 'required' : 'recommended')

  const unconfirmed = checklistFor({ ...full, badge_confirmed_at: null }, NOW)
  ok(!canComplete(unconfirmed), 'an unconfirmed badge blocks completion')
  ok(unconfirmed.find((i) => i.key === 'badge_created').done && !unconfirmed.find((i) => i.key === 'badge_confirmed').done, 'created and confirmed are two lines, and only the first is done')

  const expired = checklistFor({ ...full, badge_expires_at: NOW - 1 }, NOW)
  ok(!expired.find((i) => i.key === 'badge_confirmed').done && /renew/i.test(expired.find((i) => i.key === 'badge_confirmed').detail ?? ''), 'an expired badge un-does confirmation and says to renew')

  const noTeam = checklistFor({ ...full, team_name: null }, NOW)
  ok(noTeam.find((i) => i.key === 'role_assigned').done && canComplete(noTeam), 'no team never blocks — a role is always assigned, a team is the admin’s to add')

  const halfName = checklistFor({ ...full, last_name: null }, NOW)
  ok(!canComplete(halfName), 'a first name alone is not a complete profile')
}

/* --- the order, and where to resume ----------------------------------------- */
{
  ok(nextStep('profile') === 'setup' && nextStep('badge') === 'checklist' && nextStep('checklist') === null, 'steps chain in the brief’s order and end')
  ok(resumeStep(null) === 'profile' && resumeStep(undefined) === 'profile', 'nothing stored means the beginning')
  ok(resumeStep('walkthrough') === 'walkthrough', 'a stored step is where a phone reopens')
  ok(resumeStep('some-step-from-a-later-version') === 'profile', 'a step this build does not know means the beginning, not a screen that does not exist')
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== onboarding facts mean what the console says they mean ===')
