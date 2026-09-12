import { record } from './audit'
import { canInvite } from './invites'
import type { Env, SessionUser } from './types'

/**
 * What the company looks like on a badge: its logo and its website.
 *
 * Both are optional, and the badge is issued without them — a missing logo
 * becomes a name lockup and a missing website becomes a note asking the admin
 * to add one, rather than either blocking a rep from being ready to sell. But
 * both are validated hard when present, because the logo travels to every
 * phone in the company and the website becomes a QR code people will scan.
 */

export interface CompanyDTO {
  name: string
  timezone: string
  logoUrl?: string
  website?: string
}

type Failure = { error: string; status: number }
const fail = (error: string, status: number): Failure => ({ error, status })

/**
 * The same shape and size rule as a user's avatar (`user.avatar` in
 * mutations.ts): an image data URL, JPEG/PNG/WebP, under 64KB. Generous for a
 * compressed logo and far too small to be a way of storing anything else.
 */
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/
export const MAX_LOGO_BYTES = 64_000
export const MAX_WEBSITE = 200

/** A usable http(s) URL, or a reason it is not. `https://` is assumed if omitted. */
export function cleanWebsite(input: unknown): string | null | Failure {
  if (input === null || input === undefined || input === '') return null
  if (typeof input !== 'string') return fail('The website must be text.', 400)
  const raw = input.trim()
  if (raw.length > MAX_WEBSITE) return fail(`Keep the website under ${MAX_WEBSITE} characters.`, 400)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return fail('That does not look like a website address.', 400)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return fail('The website has to start with https:// or http://.', 400)
  }
  if (!url.hostname.includes('.')) return fail('That does not look like a website address.', 400)
  if (url.username || url.password) return fail('A website address cannot carry a login.', 400)
  return url.toString()
}

export function cleanLogo(input: unknown): string | null | Failure {
  if (input === null || input === undefined || input === '') return null
  if (typeof input !== 'string' || !IMAGE_DATA_URL.test(input)) {
    return fail('The logo has to be a JPEG, PNG or WebP image.', 400)
  }
  if (input.length > MAX_LOGO_BYTES) return fail('That logo is too large. Use a smaller image.', 400)
  return input
}

/**
 * Only the fields present in the input change. `null` clears one; an absent
 * key leaves it alone — so a screen that edits the website does not have to
 * re-send the logo to keep it.
 */
export async function updateCompany(
  env: Env,
  actor: SessionUser,
  input: { website?: unknown; logo?: unknown },
): Promise<CompanyDTO | Failure> {
  if (!canInvite(actor)) return fail('Not permitted.', 403)

  const sets: string[] = []
  const binds: (string | null)[] = []
  const changed: Record<string, unknown> = {}

  if ('website' in input) {
    const website = cleanWebsite(input.website)
    if (website !== null && typeof website !== 'string') return website
    sets.push(`website = ?${binds.length + 2}`)
    binds.push(website)
    changed.website = website
  }
  if ('logo' in input) {
    const logo = cleanLogo(input.logo)
    if (logo !== null && typeof logo !== 'string') return logo
    sets.push(`logo_url = ?${binds.length + 2}`)
    binds.push(logo)
    changed.logo = logo ? 'set' : 'cleared'
  }
  if (sets.length === 0) return fail('Nothing to change.', 400)

  await env.DB.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?1`)
    .bind(actor.clientId, ...binds)
    .run()

  await record(env, actor, {
    action: 'company.changed',
    targetType: 'company',
    targetId: actor.clientId,
    targetLabel: actor.clientName,
    detail: changed,
  })

  const row = await env.DB.prepare(
    'SELECT name, timezone, logo_url, website FROM clients WHERE id = ?1',
  )
    .bind(actor.clientId)
    .first<{ name: string; timezone: string; logo_url: string | null; website: string | null }>()
  return {
    name: row?.name ?? actor.clientName,
    timezone: row?.timezone ?? actor.timezone,
    logoUrl: row?.logo_url ?? undefined,
    website: row?.website ?? undefined,
  }
}
