import type { MailMessage } from './mail'

/**
 * The invitation email.
 *
 * One template, written for a phone: the rep reads this in a truck, taps one
 * link, and lands on the page that sets their password. So there is one
 * button, the link is also written out in full (mail clients strip buttons),
 * and the whole thing says what will happen before it happens.
 *
 * Nothing in here is a secret. The link is the credential, and it is the same
 * link the admin sees on screen. No password ever appears in an email — the
 * whole design of invitations is that nobody but the rep ever knows theirs.
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
    ? `Your ${opts.clientName} invitation, again`
    : `${opts.invitedBy} added you to ${opts.clientName} on Allstar`

  const text = [
    greeting,
    '',
    `${opts.invitedBy} has added you to ${opts.clientName}'s team on Allstar, the app you'll use to work your doors.`,
    '',
    'Open this link on your phone to choose a password and get started:',
    opts.url,
    '',
    `The link works once and expires on ${expires}. If it has expired, ask ${opts.invitedBy} to send a new one.`,
    '',
    `After you set your password, open ${opts.appUrl} and sign in. On a phone, use "Add to Home Screen" so Allstar opens full-screen and works without signal.`,
    '',
    "If you weren't expecting this, you can ignore it — nothing happens unless the link is opened.",
  ].join('\n')

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 16px;background:#f5f6f8;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:28px 24px">
    <p style="margin:0 0 16px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7280">Allstar</p>
    <p style="margin:0 0 12px">${escape(greeting)}</p>
    <p style="margin:0 0 20px"><strong>${escape(opts.invitedBy)}</strong> has added you to <strong>${escape(opts.clientName)}</strong>'s team on Allstar, the app you'll use to work your doors.</p>
    <p style="margin:0 0 20px">
      <a href="${escape(opts.url)}" style="display:inline-block;min-height:48px;line-height:48px;padding:0 22px;border-radius:12px;background:#0f766e;color:#fff;font-weight:600;text-decoration:none">Choose a password and get started</a>
    </p>
    <p style="margin:0 0 20px;font-size:14px;color:#374151">Or open this link on your phone:<br><a href="${escape(opts.url)}" style="color:#0f766e;word-break:break-all">${escape(opts.url)}</a></p>
    <p style="margin:0 0 20px;font-size:14px;color:#374151">The link works once and expires on <strong>${escape(expires)}</strong>. If it has expired, ask ${escape(opts.invitedBy)} to send a new one.</p>
    <p style="margin:0 0 20px;font-size:14px;color:#374151">After you set your password, open <a href="${escape(opts.appUrl)}" style="color:#0f766e">${escape(opts.appUrl)}</a> and sign in. On a phone, use <em>Add to Home Screen</em> so Allstar opens full-screen and works without signal.</p>
    <p style="margin:0;font-size:13px;color:#6b7280">If you weren't expecting this, you can ignore it. Nothing happens unless the link is opened.</p>
  </div>
</body></html>`

  return { to: opts.to, subject, text, html }
}
