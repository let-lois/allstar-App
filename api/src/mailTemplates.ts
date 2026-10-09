import type { MailMessage } from './mail'

/**
 * The invitation email.
 *
 * One template, written for a phone: the rep reads this in a truck, taps one
 * link, and lands on the page that sets their password. So there is one
 * button, the link is also written out in full (mail clients strip buttons),
 * and the whole thing says what will happen before it happens.
 *
 * The body tells them what the setup actually is — profile, permissions, the
 * short walkthrough, the badge — because the honest answer to "how long will
 * this take" is about a minute, and an invitation that does not say so reads
 * like the start of an afternoon.
 *
 * Two things the brief's copy did not have are here on purpose. Who invited
 * them, because an invitation that does not name a colleague is
 * indistinguishable from phishing, and it is the first thing a careful person
 * looks for. And when the link expires, because it does, in seven days, and a
 * rep who reads this on a Monday off needs to know that.
 *
 * Nothing in here is a secret. The link is the credential, and it is the same
 * link the admin sees on screen. No password ever appears in an email — the
 * whole design of invitations is that nobody but the rep ever knows theirs.
 *
 * Laid out with a table and inline styles rather than modern CSS: Outlook
 * ignores flexbox and strips <style> blocks, and this has to survive there.
 */

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export function inviteEmail(opts: {
  to: { email: string; name?: string }
  clientName: string
  invitedBy: string
  url: string
  expiresAt: number
  appUrl: string
  resent: boolean
}): MailMessage {
  const first = opts.to.name?.split(' ')[0]
  const greeting = first ? `Hi ${first},` : 'Hi,'
  const expires = new Date(opts.expiresAt).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  const subject = opts.resent
    ? `Your invitation to join ${opts.clientName} on Allstar, again`
    : `You're invited to join ${opts.clientName} on Allstar`

  const steps = [
    'Completing your profile',
    'Enabling app permissions',
    'Learning the basic Allstar workflow',
    'Creating your Team Member Badge',
    'Getting ready to start knocking',
  ]

  const text = [
    greeting,
    '',
    `You've been invited by ${opts.invitedBy} to join ${opts.clientName} on Allstar, your team's field sales platform.`,
    '',
    'Your account has already been started for you. Complete your profile to begin using your assigned territories, leads, and sales tools.',
    '',
    'Complete your setup:',
    opts.url,
    '',
    "Once you open Allstar, we'll automatically use any information your administrator has already provided, so you only need to complete the missing details. It takes about a minute.",
    '',
    'Your setup includes:',
    ...steps.map((s) => `  - ${s}`),
    '',
    `This link works once and expires on ${expires}. If it has expired, ask ${opts.invitedBy} to send a new one.`,
    '',
    `Allstar lives at ${opts.appUrl}. On a phone, use "Add to Home Screen" so it opens full-screen and keeps working without signal.`,
    '',
    "If you weren't expecting this invitation, you can ignore this email. Nothing happens unless the link is opened.",
    '',
    '— The Allstar Team',
  ].join('\n')

  const li = steps
    .map(
      (s) =>
        `<tr><td style="padding:0 0 8px 0;font-size:15px;color:#374151"><span style="color:#0f766e;font-weight:700">&bull;</span>&nbsp;&nbsp;${escape(s)}</td></tr>`,
    )
    .join('')

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#f5f6f8;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#fff;border-radius:16px">
      <tr><td style="padding:28px 24px">
        <p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0f766e">Allstar</p>
        <p style="margin:0 0 14px">${escape(greeting)}</p>
        <p style="margin:0 0 14px">You've been invited by <strong>${escape(opts.invitedBy)}</strong> to join <strong>${escape(opts.clientName)}</strong> on Allstar, your team's field sales platform.</p>
        <p style="margin:0 0 24px">Your account has already been started for you. Complete your profile to begin using your assigned territories, leads, and sales tools.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="border-radius:12px;background:#0f766e">
          <a href="${escape(opts.url)}" style="display:inline-block;min-height:48px;line-height:48px;padding:0 26px;border-radius:12px;background:#0f766e;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none">Complete your setup</a>
        </td></tr></table>
        <p style="margin:0 0 24px;font-size:14px;color:#374151">Or open this link on your phone:<br><a href="${escape(opts.url)}" style="color:#0f766e;word-break:break-all">${escape(opts.url)}</a></p>
        <p style="margin:0 0 16px;font-size:15px;color:#374151">Once you open Allstar, we'll automatically use any information your administrator has already provided, so you only need to complete the missing details. It takes about a minute.</p>
        <p style="margin:0 0 10px;font-size:15px;font-weight:600">Your setup includes:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">${li}</table>
        <p style="margin:0 0 20px;font-size:14px;color:#374151">This link works once and expires on <strong>${escape(expires)}</strong>. If it has expired, ask ${escape(opts.invitedBy)} to send a new one.</p>
        <p style="margin:0 0 20px;font-size:14px;color:#374151">Allstar lives at <a href="${escape(opts.appUrl)}" style="color:#0f766e">${escape(opts.appUrl)}</a>. On a phone, use <em>Add to Home Screen</em> so it opens full-screen and keeps working without signal.</p>
        <p style="margin:0 0 18px;font-size:13px;color:#6b7280">If you weren't expecting this invitation, you can ignore this email. Nothing happens unless the link is opened.</p>
        <p style="margin:0;font-size:13px;color:#6b7280">&mdash; The Allstar Team</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`

  return { to: opts.to, subject, text, html }
}

/**
 * The link that lets somebody choose a new password, because they asked.
 *
 * Shorter and plainer than the invitation on purpose. The person pressed
 * "Forgot password?" a moment ago and is waiting for this, so there is nothing
 * to introduce and nothing to sell — only which button to press and how long
 * it works. It names the company, because one address can belong to accounts
 * at more than one and each gets its own link.
 *
 * It never says whether anything else happened. The request that produced it
 * answers the same way whether or not the address was known, and an email
 * that hinted otherwise would give that away to whoever typed the address.
 */
export function resetEmail(opts: {
  to: { email: string; name?: string }
  clientName: string
  url: string
  expiresAt: number
  appUrl: string
  /**
   * The administrator who sent it from Team → Manage. Named, for the same
   * reason an invitation names its sender: a reset email nobody asked for,
   * from nobody in particular, is what phishing looks like. Absent for the
   * sign-in screen's "Forgot password?", where the person asked themselves.
   */
  requestedBy?: string
}): MailMessage {
  const first = opts.to.name?.split(' ')[0]
  const greeting = first ? `Hi ${first},` : 'Hi,'
  const asked = opts.requestedBy
    ? `${opts.requestedBy}, an administrator at ${opts.clientName}, sent you this link to choose a new password for your Allstar account.`
    : `Somebody — hopefully you — asked to reset the password for your ${opts.clientName} account on Allstar.`
  const askedHtml = opts.requestedBy
    ? `<strong>${escape(opts.requestedBy)}</strong>, an administrator at <strong>${escape(opts.clientName)}</strong>, sent you this link to choose a new password for your Allstar account.`
    : `Somebody &mdash; hopefully you &mdash; asked to reset the password for your <strong>${escape(opts.clientName)}</strong> account on Allstar.`
  const ignore = opts.requestedBy
    ? `If you weren't expecting this, you can ignore it — nothing changes unless the link is opened — and let ${opts.requestedBy} know.`
    : `If you didn't ask for this, you can ignore it. Nothing changes unless the link is opened, and nobody can use it without this email.`
  const expires = new Date(opts.expiresAt).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
  const subject = `Reset your ${opts.clientName} password on Allstar`

  const text = [
    greeting,
    '',
    asked,
    '',
    'Choose a new password:',
    opts.url,
    '',
    `This link works once and expires on ${expires}. Your current password keeps working until you set a new one.`,
    '',
    ignore,
    '',
    `Allstar lives at ${opts.appUrl}.`,
    '',
    '— The Allstar Team',
  ].join('\n')

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#f5f6f8;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#fff;border-radius:16px">
      <tr><td style="padding:28px 24px">
        <p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0f766e">Allstar</p>
        <p style="margin:0 0 14px">${escape(greeting)}</p>
        <p style="margin:0 0 24px">${askedHtml}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="border-radius:12px;background:#0f766e">
          <a href="${escape(opts.url)}" style="display:inline-block;min-height:48px;line-height:48px;padding:0 26px;border-radius:12px;background:#0f766e;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none">Choose a new password</a>
        </td></tr></table>
        <p style="margin:0 0 24px;font-size:14px;color:#374151">Or open this link on your phone:<br><a href="${escape(opts.url)}" style="color:#0f766e;word-break:break-all">${escape(opts.url)}</a></p>
        <p style="margin:0 0 20px;font-size:14px;color:#374151">This link works once and expires on <strong>${escape(expires)}</strong>. Your current password keeps working until you set a new one.</p>
        <p style="margin:0 0 18px;font-size:13px;color:#6b7280">${escape(ignore)}</p>
        <p style="margin:0 0 18px;font-size:13px;color:#6b7280">Allstar lives at <a href="${escape(opts.appUrl)}" style="color:#0f766e">${escape(opts.appUrl)}</a>.</p>
        <p style="margin:0;font-size:13px;color:#6b7280">&mdash; The Allstar Team</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`

  return { to: opts.to, subject, text, html }
}

/**
 * "The address you sign in with changed." Sent to both addresses.
 *
 * To the old one it is the alarm: if the change was not expected, this is
 * the only place the person learns of it, so it says who made it and who to
 * talk to. To the new one it is the instruction: which address to type from
 * now on, and that the password is the same. Neither contains a link that
 * does anything but open the app — there is nothing to confirm, and an email
 * that asks to "confirm" an account change is the shape of a phishing kit.
 */
export function emailChangedEmail(opts: {
  to: { email: string; name?: string }
  side: 'previous' | 'next'
  clientName: string
  /** The admin who made the change; absent when the person changed their own. */
  changedBy?: string
  previous: string
  next: string
  appUrl: string
}): MailMessage {
  const first = opts.to.name?.split(' ')[0]
  const greeting = first ? `Hi ${first},` : 'Hi,'
  const by = opts.changedBy ? ` by ${opts.changedBy}, an administrator at ${opts.clientName}` : ''
  const subject =
    opts.side === 'previous'
      ? `Your ${opts.clientName} sign-in email was changed`
      : `You now sign in to ${opts.clientName} on Allstar with this address`
  const lead =
    opts.side === 'previous'
      ? `The email you use to sign in to your ${opts.clientName} account on Allstar was changed${by}. You will sign in with ${opts.next} from now on.`
      : `Your ${opts.clientName} account on Allstar now signs in with this address (${opts.next}). It was changed${by} from ${opts.previous}.`
  const after =
    opts.side === 'previous'
      ? `Your password has not changed. If you didn't expect this, contact ${opts.changedBy ?? `your administrator at ${opts.clientName}`} straight away.`
      : 'Your password has not changed — use the one you already have.'

  const text = [greeting, '', lead, '', after, '', `Allstar lives at ${opts.appUrl}.`, '', '— The Allstar Team'].join('\n')

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#f5f6f8;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#fff;border-radius:16px">
      <tr><td style="padding:28px 24px">
        <p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0f766e">Allstar</p>
        <p style="margin:0 0 14px">${escape(greeting)}</p>
        <p style="margin:0 0 20px">${escape(lead)}</p>
        <p style="margin:0 0 20px;font-size:14px;color:#374151">${escape(after)}</p>
        <p style="margin:0 0 18px;font-size:13px;color:#6b7280">Allstar lives at <a href="${escape(opts.appUrl)}" style="color:#0f766e">${escape(opts.appUrl)}</a>.</p>
        <p style="margin:0;font-size:13px;color:#6b7280">&mdash; The Allstar Team</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`

  return { to: opts.to, subject, text, html }
}
