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
 * ## Why MailChannels, and what it costs to set up
 *
 * Cloudflare's own `send_email` binding delivers only to addresses verified in
 * Email Routing — right for alerting yourself, useless for a new rep's inbox.
 * MailChannels is an HTTPS API reachable from a Worker with an API key. Since
 * mid-2024 that is a paid plan, and the sending domain needs two DNS records
 * (their Domain Lockdown TXT and an SPF include; DKIM recommended) before mail
 * is accepted. None of that is code; all of it is in the operator notes in
 * wrangler.toml.
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
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`${res.status}${detail ? ` ${detail}` : ''}`)
    }
  },
}

const PROVIDER: MailProvider = mailchannels

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
  return !!env.MAILCHANNELS_API_KEY?.trim() && parseFrom(env.MAIL_FROM) !== null
}

export async function sendMail(env: Env, msg: MailMessage): Promise<MailResult> {
  const from = parseFrom(env.MAIL_FROM)
  if (!env.MAILCHANNELS_API_KEY?.trim() || !from) {
    return { sent: false, error: 'Email is not configured on this deployment.' }
  }
  try {
    await PROVIDER.send(env, from, msg)
    return { sent: true, provider: PROVIDER.name }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[allstar] mail via ${PROVIDER.name} failed: ${reason}`)
    return { sent: false, error: `The email could not be sent (${reason.slice(0, 120)}).` }
  }
}
