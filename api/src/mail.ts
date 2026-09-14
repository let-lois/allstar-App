import type { Env } from './types'

/**
 * Sending email from the Worker.
 *
 * One provider today, behind an interface, for the reason the geocoders are:
 * a mail provider is a commercial relationship that changes, and the code that
 * decides *what* to send must not know *who* carries it. Switching providers
 * is one object in this file.
 *
 * ## What "configured" means
 *
 * Two values, both Worker secrets: the provider's API key and the address mail
 * comes from. With either missing, `mailConfigured` is false and every caller
 * falls back to what it did before this file existed — hand the admin a link
 * to send themselves. `/api/health` reports the flag so a deployment that
 * *thinks* it emails invitations and does not is visible from outside.
 *
 * ## Never the reason an operation fails
 *
 * `sendMail` does not throw. An invitation is minted whether or not the email
 * goes out; the caller learns `sent: false` and a reason, and the console shows
 * the link with an honest sentence. A mail provider having a bad minute must
 * not stop an admin adding somebody to the team. It is also bounded: a provider
 * that hangs is a failure after eight seconds, not a request that never ends.
 *
 * ## Which provider carries it
 *
 * Two are implemented, and the first one configured wins: Resend, then
 * MailChannels. That order is deliberate rather than alphabetical — Resend is
 * the one this deployment is being set up with, and an operator who sets its
 * key expects mail to go that way without also having to unset anything else.
 * `/api/health` names the provider actually in use, so "which one sent that?"
 * is answerable from outside without reading secrets.
 *
 * Cloudflare's own `send_email` binding is not one of the options: it delivers
 * only to addresses verified in Email Routing, which is right for alerting
 * yourself and useless for a new rep's inbox.
 *
 * Both providers need their sending domain verified by DNS before they will
 * carry mail to a stranger, and both refuse in their own words until it is.
 * None of that is code; all of it is in the operator notes in wrangler.toml.
 */

export interface MailMessage {
  to: { email: string; name?: string }
  subject: string
  text: string
  html: string
}

export type MailResult = { sent: true; provider: string } | { sent: false; error: string }

interface MailProvider {
  name: string
  send(env: Env, from: { email: string; name?: string }, msg: MailMessage): Promise<void>
}

/** How long a provider gets before the send is called failed. */
const SEND_TIMEOUT_MS = 8_000

/**
 * A refusal, as a sentence an administrator can act on.
 *
 * Providers answer failures as JSON, and the useful part is one field inside
 * it. Passing the raw body through looked fine until the message that matters
 * most — Resend's "verify a domain at resend.com/domains", which every new
 * account meets — was pushed past the console's truncation by the braces and
 * field names in front of it. So the sentence is pulled out and the envelope
 * is dropped. The status stays, because "403" and "500" are acted on
 * differently and neither provider always says which it was in words.
 */
async function describeFailure(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => '')).trim()
  let detail = ''
  try {
    const body = JSON.parse(raw) as { message?: unknown; errors?: unknown; error?: unknown }
    if (typeof body.message === 'string') detail = body.message
    else if (Array.isArray(body.errors)) detail = body.errors.filter((e) => typeof e === 'string').join('; ')
    else if (typeof body.error === 'string') detail = body.error
  } catch {
    // Not JSON — a gateway's HTML error page, or nothing at all. The first
    // line of it is more use than none, and the whole page is no use at all.
    detail = raw.split('\n')[0] ?? ''
  }
  return `${res.status}${detail ? ` ${detail.slice(0, 220)}` : ''}`
}

/**
 * Resend's transactional API. Base URL overridable for a stand-in in tests.
 *
 * `from` is one string here rather than a pair, and `to` is a list — the shape
 * their API takes, built from the same parsed pair every provider gets, so the
 * callers never learn which one is carrying the message.
 *
 * Worth knowing about the failures, because the first one is the one you will
 * meet: until the sending domain is verified, Resend accepts mail only to the
 * address that owns the account, and says so in the body of a 403. That text
 * is carried back verbatim to the console rather than flattened into "could
 * not send", because the two are fixed in completely different places.
 */
const resend: MailProvider = {
  name: 'resend',
  async send(env, from, msg) {
    const base = (env.RESEND_BASE_URL ?? 'https://api.resend.com').replace(/\/$/, '')
    const res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.RESEND_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        from: from.name ? `${from.name} <${from.email}>` : from.email,
        to: [msg.to.email],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(await describeFailure(res))
  },
}

/** MailChannels' transactional API. Base URL overridable for a stand-in in tests. */
const mailchannels: MailProvider = {
  name: 'mailchannels',
  async send(env, from, msg) {
    const base = (env.MAIL_BASE_URL ?? 'https://api.mailchannels.net').replace(/\/$/, '')
    const res = await fetch(`${base}/tx/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Api-Key': env.MAILCHANNELS_API_KEY ?? '' },
      body: JSON.stringify({
        personalizations: [{ to: [msg.to.name ? { email: msg.to.email, name: msg.to.name } : { email: msg.to.email }] }],
        from: from.name ? { email: from.email, name: from.name } : { email: from.email },
        subject: msg.subject,
        content: [
          { type: 'text/plain', value: msg.text },
          { type: 'text/html', value: msg.html },
        ],
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    // 202 Accepted is the success shape. Anything else carries a reason worth
    // keeping — a wrong key and an unverified domain read very differently.
    if (!res.ok) throw new Error(await describeFailure(res))
  },
}

/**
 * The provider this deployment will actually use, and the address it sends
 * from — or null when nothing is configured.
 *
 * A provider counts as configured only with *both* halves: a key and a usable
 * from-address. Half-configured is the state that looks fine in a dashboard
 * and silently drops mail, so it is treated as off.
 *
 * `RESEND_FROM_EMAIL` is the name your setup brief uses; `MAIL_FROM` is what
 * this file shipped with. Either works for either provider, so an operator who
 * set one of them and then switched providers does not get a silent outage.
 */
function active(env: Env): { provider: MailProvider; from: { email: string; name?: string } } | null {
  const from = parseFrom(env.RESEND_FROM_EMAIL) ?? parseFrom(env.MAIL_FROM)
  if (!from) return null
  if (env.RESEND_API_KEY?.trim()) return { provider: resend, from }
  if (env.MAILCHANNELS_API_KEY?.trim()) return { provider: mailchannels, from }
  return null
}

/** `Name <addr@example.com>` or a bare address. Null when unusable. */
export function parseFrom(raw: string | undefined): { email: string; name?: string } | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(s)
  if (m) {
    const name = m[1]?.trim().replace(/^"|"$/g, '')
    return name ? { email: m[2]!, name } : { email: m[2]! }
  }
  return /^[^<>\s]+@[^<>\s]+$/.test(s) ? { email: s } : null
}

export function mailConfigured(env: Env): boolean {
  return active(env) !== null
}

/** Which provider is carrying mail, for `/api/health`. Never a key, only a name. */
export function mailProvider(env: Env): string | null {
  return active(env)?.provider.name ?? null
}

export async function sendMail(env: Env, msg: MailMessage): Promise<MailResult> {
  const use = active(env)
  if (!use) return { sent: false, error: 'Email is not configured on this deployment.' }
  try {
    await use.provider.send(env, use.from, msg)
    return { sent: true, provider: use.provider.name }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    /*
      The recipient is logged, the reason is logged, the key is not — it never
      enters this string, and the provider's own error bodies do not echo it.
      An operator reading `wrangler tail` needs to know which address failed
      and why; anyone reading the log over their shoulder needs neither.
    */
    console.error(`[allstar] mail via ${use.provider.name} to ${msg.to.email} failed: ${reason}`)
    return { sent: false, error: `The email could not be sent (${reason.slice(0, 260)}).` }
  }
}
