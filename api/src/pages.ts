/**
 * The two HTML pages the Worker serves itself.
 *
 * Account bootstrap can't live in the React app: the first administrator exists
 * before anyone can sign in, and an invited rep has no account yet either.
 * Serving them from the Worker keeps the whole path self-contained — deploy,
 * open a URL, and you have an account.
 *
 * Mobile-first for the same reason as the rest of the product: a rep accepts
 * their invite on the phone they'll be knocking with, standing in a truck.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

function shell(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)} · Allstar</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    padding: 24px calc(16px + env(safe-area-inset-left)) calc(24px + env(safe-area-inset-bottom));
    background: #0b1220; color: #fff;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card { width: 100%; max-width: 420px; }
  .mark {
    display: grid; place-items: center; width: 48px; height: 48px;
    border-radius: 14px; background: #2563eb; font-weight: 800; font-size: 20px;
  }
  h1 { font-size: 26px; margin: 20px 0 6px; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: #94a3b8; font-size: 14px; }
  label { display: block; margin-bottom: 14px; }
  label span { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #cbd5e1; }
  input {
    width: 100%; min-height: 52px; padding: 0 14px; border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06);
    color: #fff; font-size: 16px; /* 16px or iOS zooms the page on focus */
  }
  input:focus { outline: 2px solid #2563eb; outline-offset: 2px; }
  input[readonly] { opacity: 0.6; }
  button {
    width: 100%; min-height: 56px; margin-top: 8px; border: 0; border-radius: 16px;
    background: #2563eb; color: #fff; font-size: 17px; font-weight: 700; cursor: pointer;
  }
  button:active { background: #1d4ed8; }
  .err {
    background: rgba(220,38,38,0.15); border: 1px solid rgba(248,113,113,0.4);
    color: #fecaca; padding: 12px 14px; border-radius: 12px; font-size: 14px; margin-bottom: 18px;
  }
  .ok {
    background: rgba(16,185,129,0.15); border: 1px solid rgba(52,211,153,0.4);
    color: #bbf7d0; padding: 12px 14px; border-radius: 12px; font-size: 14px; margin-bottom: 18px;
  }
  .hint { margin-top: 18px; color: #64748b; font-size: 12px; line-height: 1.6; }
  a { color: #93c5fd; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

export function setupPage(opts: { error?: string; done?: boolean; appUrl: string }): Response {
  if (opts.done) {
    return shell(
      'Setup complete',
      `<div class="mark">A</div>
       <h1>You're set up</h1>
       <div class="ok">Your administrator account is ready.</div>
       <p class="sub">Sign in at <a href="${escapeHtml(opts.appUrl)}">${escapeHtml(opts.appUrl)}</a>,
       then invite your team from the console.</p>
       <p class="hint">This setup page has now disabled itself permanently. Remove the
       SETUP_TOKEN secret from the Worker when convenient.</p>`,
    )
  }

  return shell(
    'Set up Allstar',
    `<div class="mark">A</div>
     <h1>Set up Allstar</h1>
     <p class="sub">Creates your company and its first administrator. This page works once.</p>
     ${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ''}
     <form method="POST" action="/setup">
       <label><span>Setup token</span>
         <input name="token" type="password" required autocomplete="off"
                placeholder="The SETUP_TOKEN secret you set"></label>
       <label><span>Company name</span>
         <input name="clientName" required autocomplete="organization" placeholder="Summit Exteriors"></label>
       <label><span>Your name</span>
         <input name="name" required autocomplete="name"></label>
       <label><span>Email</span>
         <input name="email" type="email" required autocomplete="email" inputmode="email"></label>
       <label><span>Password</span>
         <input name="password" type="password" required autocomplete="new-password"
                minlength="10" placeholder="At least 10 characters"></label>
       <button type="submit">Create administrator</button>
     </form>
     <p class="hint">Nobody ever handles a password hash in this system — you set yours here,
     your team sets theirs from an invite link.</p>`,
  )
}

export function invitePage(opts: {
  token: string
  invite?: { email: string; name: string; clientName: string; alreadyActive?: boolean }
  error?: string
  done?: boolean
  appUrl: string
}): Response {
  /*
    An invitation link for somebody who already has a password — they joined
    with the company code, or set it through an earlier link. No form: a form
    here is how a forwarded email becomes a way to lock the real owner out.
  */
  if (opts.invite?.alreadyActive) {
    return shell(
      'You already have an account',
      `<div class="mark">A</div>
       <h1>You're already set up</h1>
       <div class="ok">This ${escapeHtml(opts.invite.clientName)} account already has a password.</div>
       <p class="sub">Open <a href="${escapeHtml(opts.appUrl)}">${escapeHtml(opts.appUrl)}</a> and sign in with it.</p>
       <p class="hint">Forgotten it? Ask your administrator for a reset link — this invitation cannot change it.</p>`,
    )
  }

  if (opts.done) {
    return shell(
      'Password set',
      `<div class="mark">A</div>
       <h1>You're in</h1>
       <div class="ok">Your password is set.</div>
       <p class="sub">Open <a href="${escapeHtml(opts.appUrl)}">${escapeHtml(opts.appUrl)}</a> and sign in.</p>
       <p class="hint">On a phone, use your browser's "Add to Home Screen" so Allstar opens
       full-screen and works without signal.</p>`,
    )
  }

  if (!opts.invite) {
    return shell(
      'Invite unavailable',
      `<div class="mark">A</div>
       <h1>This link has expired</h1>
       <p class="sub">Invites are single-use, last seven days, and stop working when a newer one is sent.</p>
       <p class="hint">Already set a password? Just open <a href="${escapeHtml(opts.appUrl)}">${escapeHtml(opts.appUrl)}</a>
       and sign in. Otherwise, ask your administrator to send a new link.</p>`,
    )
  }

  return shell(
    'Set your password',
    `<div class="mark">A</div>
     <h1>Welcome, ${escapeHtml(opts.invite.name.split(' ')[0] ?? '')}</h1>
     <p class="sub">Set a password for your ${escapeHtml(opts.invite.clientName)} account.</p>
     ${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ''}
     <form method="POST" action="/invite/${escapeHtml(opts.token)}">
       <label><span>Email</span>
         <input value="${escapeHtml(opts.invite.email)}" readonly autocomplete="username"></label>
       <label><span>Choose a password</span>
         <input name="password" type="password" required autocomplete="new-password"
                minlength="10" autofocus placeholder="At least 10 characters"></label>
       <button type="submit">Set password</button>
     </form>
     <p class="hint">Only you will know this password. Nobody at your company can see it.</p>`,
  )
}
