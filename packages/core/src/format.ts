import { dayKeyIn } from './day'

export function money(n?: number): string {
  if (n == null) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return `$${Math.round(n)}`
}

export function moneyFull(n?: number): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

export function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * `YYYY-MM-DD` for an instant.
 *
 * With a company timezone, on that company's calendar; without one, on this
 * device's clock. The second case is not a fallback so much as the demo's
 * correct answer — it has no server and no company, and its seeded day should
 * look like today to whoever opens it.
 *
 * Anything that has to line up with a number the *server* produced must pass
 * the zone. Reporting rows are bucketed on the company's calendar, so asking
 * this in the device's clock and comparing the two is how a rep's board ends up
 * disagreeing with their manager's console about the same evening.
 */
export function dayKey(ts: number = Date.now(), tz?: string | null): string {
  return dayKeyIn(ts, tz)
}

/** "3m ago", "2h ago", "Tue" — short enough for a dense mobile row. */
export function relative(ts?: number): string {
  if (!ts) return 'Never'
  const diff = Date.now() - ts
  const abs = Math.abs(diff)
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (abs < min) return diff >= 0 ? 'Just now' : 'Now'
  if (abs < hour) {
    const v = Math.round(abs / min)
    return diff >= 0 ? `${v}m ago` : `in ${v}m`
  }
  if (abs < day) {
    const v = Math.round(abs / hour)
    return diff >= 0 ? `${v}h ago` : `in ${v}h`
  }
  if (abs < 7 * day) {
    const v = Math.round(abs / day)
    return diff >= 0 ? `${v}d ago` : `in ${v}d`
  }
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * `relative` phrased to sit mid-sentence ("Last visit 3d ago").
 * Only the prose forms are lowercased — an absolute date keeps its capital, so
 * we don't end up rendering "Last visit jul 28".
 */
export function relativeLower(ts?: number): string {
  const s = relative(ts)
  return /^[A-Z][a-z]{2} \d/.test(s) ? s : s.toLowerCase()
}

export function duration(ms?: number): string {
  if (!ms) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Digits only — `tel:` links choke on formatting in some Android dialers. */
export function telHref(phone?: string): string | undefined {
  if (!phone) return undefined
  const digits = phone.replace(/[^\d+]/g, '')
  return digits ? `tel:${digits}` : undefined
}

/*
  `smsHref` and `mailHref` used to live here, exported. They moved to
  `lib/contact.ts` and are private there, so the only way to build a message or
  email link to a homeowner is `homeownerContact(property, contact)` — which
  takes the property, and therefore the Do Not Contact status that governs it.
  They were exported here and used without that check, which is how a household
  that asked not to be contacted kept its Text and Email buttons.

  `telHref` stays, because Team and Rep Detail call colleagues, who have no lead
  status. `scripts/verify-dnc.mjs` holds the allowlist of files allowed to import
  it.
*/

/**
 * "Round Rock, TX 78664" — from whichever of those three parts exist.
 *
 * Needed because a lead added from the field may have none of them. The add-lead
 * screen used to stamp a hardcoded city, state and ZIP on every lead, which was
 * wrong the moment a second territory existed; it now stores blank rather than
 * guessing. Blank is the honest value and the office can fix it — but three
 * screens interpolated `{city}, {state} {zip}` directly, so an unknown town
 * rendered as a bare comma and read as a bug.
 *
 * Returns an empty string when nothing is known, so a caller can drop the line
 * entirely rather than print punctuation.
 */
export function cityLine(place: {
  city?: string
  state?: string
  zip?: string
}): string {
  const town = [place.city?.trim(), place.state?.trim()].filter(Boolean).join(', ')
  return [town, place.zip?.trim()].filter(Boolean).join(' ')
}
