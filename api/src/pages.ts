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

import { LOGO_PNG_BASE64 } from './brand-logo'

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
  .doc { font-size: 15px; line-height: 1.6; color: #cbd5e1; }
  .doc h2 { font-size: 17px; color: #fff; margin: 22px 0 6px; }
  .doc ul { padding-left: 20px; margin: 6px 0; }
  .doc li { margin: 4px 0; }
  .doc b { color: #fff; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

/* --- the sign-in look, for the invitation pages ------------------------- */

/*
  The invitation page is the first screen of the product an invited person
  ever sees, and the next one is the app's Login. It used to be this file's
  own navy-and-blue design with an "A" tile, so accepting an invitation felt
  like a different product from signing in.

  These rules are the Login screen's (src/screens/Login.tsx), copied as
  values because the Worker has no Tailwind build: the same ground, the same
  wordmark tile, the same 384px column, card, 56px fields, Show button and teal
  primary. Every number below is the computed value of the matching Login
  element, and `scripts/verify-authpages.mjs` measures both pages side by side
  so they cannot quietly drift apart.

  Dark is the default and light follows the phone — what Login does for anyone
  who has not picked a theme in the app. This page is on the API's origin, so
  it cannot read the app's stored choice; following the phone is the only
  honest default.
*/
const AUTH_CSS = `
  :root {
    color-scheme: dark;
    --ground: rgb(13 19 32); --ink: rgb(242 246 250); --ink-mute: rgb(147 162 184); --ink-faint: rgb(100 116 139);
    --surface: rgb(21 29 46); --tint: rgb(12 39 49); --hairline: rgb(255 255 255 / 0.14);
    --shadow-card: 0 1px 2px rgb(0 0 0 / 0.28), 0 6px 18px rgb(0 0 0 / 0.22);
    --accent: rgb(32 196 211); --accent-strong: rgb(127 224 239); --bad: #fca5a5;
    --quiet-face: rgb(255 255 255 / 0.1); --quiet-ink: #fff; --quiet-ring: rgb(32 196 211 / 0.4);
    --lift: 0 1px 2px rgb(0 0 0 / 0.28);
    --field: rgba(0, 0, 0, 0.32); --field-ring: inset 0 0 0 1px rgb(255 255 255 / 0.14);
    --field-focus: inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 0 0 2px #20c4d3;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --ground: rgb(240 242 247); --ink: rgb(17 24 39); --ink-mute: rgb(90 105 125); --ink-faint: rgb(107 124 147);
      --surface: #fff; --tint: rgb(224 246 249); --hairline: rgb(0 0 0 / 0.07);
      --shadow-card: 0 1px 2px rgb(0 0 0 / 0.06), 0 6px 18px rgb(0 0 0 / 0.06);
      --accent: rgb(10 114 128); --accent-strong: rgb(6 88 98); --bad: rgb(185 28 28);
      --quiet-face: #fff; --quiet-ink: rgb(17 24 39); --quiet-ring: rgb(0 0 0 / 0.12);
      --lift: 0 1px 2px rgb(0 0 0 / 0.08);
      --field: rgb(236 239 244); --field-ring: inset 0 0 0 1px rgb(203 213 225);
      --field-focus: inset 0 0 0 1px rgb(10 114 128), 0 0 0 2px rgb(10 114 128 / 0.35);
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; min-height: 100dvh; display: flex; flex-direction: column;
    background: var(--ground); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 16px; line-height: 1.5; letter-spacing: -0.011em; -webkit-font-smoothing: antialiased;
  }
  /* Centred with auto margins, as on Login: a taller form scrolls from its top
     instead of overflowing upward past where the page can scroll to. */
  .pane {
    flex: 1; display: flex; flex-direction: column;
    padding: calc(32px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right))
             calc(32px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
  }
  .col { width: 100%; max-width: 384px; margin: auto; }
  .lockup { margin-bottom: 28px; text-align: center; }
  .wordmark {
    display: inline-flex; background: #fff; border-radius: 20px; padding: 12px 16px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.28), 0 6px 18px rgba(0,0,0,0.22);
  }
  .wordmark img { display: block; width: 204px; max-width: 100%; height: auto; }
  h1 { margin: 20px 0 0; font-size: 23px; font-weight: 600; line-height: 1.25; letter-spacing: -0.02em; text-wrap: balance; }
  .sub { margin: 8px 0 0; color: var(--ink-mute); font-size: 14px; line-height: 1.55; text-wrap: balance; }
  .card {
    background: var(--surface); border: 1px solid var(--hairline); border-radius: 20px;
    box-shadow: var(--shadow-card); padding: 20px;
  }
  label { display: block; }
  label + label { margin-top: 14px; }
  label > span:first-child { display: block; font-size: 13px; font-weight: 500; color: var(--ink-mute); }
  .field { position: relative; display: block; margin-top: 6px; }
  input {
    display: block; width: 100%; height: 56px; margin: 0; padding: 0 16px; border: 0; border-radius: 14px;
    background: var(--field); box-shadow: var(--field-ring);
    color: var(--ink); font: inherit; font-size: 16px; /* 16px or iOS zooms the page on focus */
    transition: box-shadow 150ms ease; -webkit-appearance: none; appearance: none;
  }
  input::placeholder { color: var(--ink-faint); opacity: 1; }
  input:focus { outline: none; box-shadow: var(--field-focus); }
  input[readonly] { color: var(--ink-mute); }
  .field input[type="password"], .field input[data-revealed] { padding-right: 76px; }
  .reveal {
    position: absolute; right: 6px; top: 6px; display: grid; place-items: center; width: 64px; height: 44px;
    border: 0; border-radius: 14px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
    line-height: 16px; letter-spacing: 0.025em; text-transform: uppercase;
    background: var(--quiet-face); color: var(--quiet-ink); box-shadow: 0 0 0 1px var(--quiet-ring), var(--lift);
  }
  .primary {
    display: grid; place-items: center; width: 100%; height: 56px; margin-top: 20px; border: 0; border-radius: 14px;
    background: #0fa9b8; color: #111827; font: inherit; font-size: 17px; font-weight: 600; text-decoration: none;
    cursor: pointer; box-shadow: 0 0 0 1px rgba(127, 224, 239, 0.5), var(--lift);
    transition: box-shadow 140ms ease, filter 140ms ease;
  }
  .primary:active { box-shadow: 0 0 0 1px rgba(127, 224, 239, 0.5); filter: brightness(0.92); }
  .primary:disabled { opacity: 0.6; }
  .reveal:focus-visible, .primary:focus-visible, a:focus-visible { outline: 2px solid #20c4d3; outline-offset: 2px; }
  .alert { margin: 12px 0 0; color: var(--bad); font-size: 14px; font-weight: 500; }
  .status { margin: 0 0 4px; border-radius: 14px; background: var(--tint); padding: 10px 12px; font-size: 13.5px; line-height: 1.6; }
  .card > .status + .primary { margin-top: 16px; }
  .note { margin: 16px 0 0; color: var(--ink-mute); font-size: 13.5px; line-height: 1.6; }
  .note a, .status a { color: var(--accent); font-weight: 600; }
  .foot { margin: 32px 0 0; text-align: center; color: var(--ink-faint); font-size: 12.5px; line-height: 1.625; }
  .links { margin: 12px 0 0; display: flex; justify-content: center; gap: 20px; font-size: 13px; font-weight: 500; }
  .links a { display: inline-flex; align-items: center; min-height: 44px; color: var(--accent-strong); text-decoration: none; }
`

/*
  Show / Hide and the busy label, the two things Login does with script. The
  form works without either: the browser still checks the fields and the
  server still checks the pair.
*/
const AUTH_JS = `
  document.querySelectorAll('[data-reveal]').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = b.parentNode.querySelector('input'); var show = i.type === 'password';
      i.type = show ? 'text' : 'password'; if (show) i.setAttribute('data-revealed', ''); else i.removeAttribute('data-revealed');
      b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', String(show));
    });
  });
  document.querySelectorAll('form[data-busy]').forEach(function (f) {
    f.addEventListener('submit', function () {
      var s = f.querySelector('button[type="submit"]'); if (!s) return;
      setTimeout(function () { s.disabled = true; s.textContent = f.getAttribute('data-busy'); }, 0);
    });
  });
`

function authShell(title: string, o: { heading: string; sub?: string; card: string; foot?: string }): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="rgb(13 19 32)" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="rgb(240 242 247)" media="(prefers-color-scheme: light)">
<title>${escapeHtml(title)} · All Star</title>
<style>${AUTH_CSS}</style>
</head>
<body><div class="pane"><main class="col">
  <div class="lockup">
    <div class="wordmark"><img src="data:image/png;base64,${LOGO_PNG_BASE64}" alt="Allstar Home Solutions" width="720" height="184"></div>
    <h1>${o.heading}</h1>
    ${o.sub ? `<p class="sub">${o.sub}</p>` : ''}
  </div>
  <div class="card">${o.card}</div>
  ${o.foot ? `<p class="foot">${o.foot}</p>` : ''}
  <p class="links"><a href="/support" target="_blank" rel="noopener noreferrer">Help &amp; support</a><a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a></p>
</main></div>
<script>${AUTH_JS}</script>
</body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

const signInButton = (appUrl: string) =>
  `<a class="primary" href="${escapeHtml(appUrl)}" data-testid="open-app">Go to sign in</a>`

const passwordField = (o: { name: string; label: string; placeholder: string; autofocus?: boolean }) =>
  `<label><span>${o.label}</span>
     <span class="field">
       <input name="${o.name}" type="password" required autocomplete="new-password" minlength="10"${o.autofocus ? ' autofocus' : ''}
              placeholder="${o.placeholder}" enterkeyhint="${o.name === 'confirm' ? 'go' : 'next'}">
       <button type="button" class="reveal" data-reveal aria-pressed="false">Show</button>
     </span></label>`

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
  invite?: { email: string; name: string; clientName: string; alreadyActive?: boolean; kind?: 'invite' | 'reset' }
  error?: string
  done?: boolean
  /**
   * For the "done" page, which has no invite left to read it from — the
   * token was consumed by the same request. A reset says "changed"; an
   * invitation says "set". Defaults to the invitation wording.
   */
  kind?: 'invite' | 'reset'
  appUrl: string
}): Response {
  const reset = (opts.kind ?? opts.invite?.kind) === 'reset'
  /*
    An invitation link for somebody who already has a password — they joined
    with the company code, or set it through an earlier link. No form: a form
    here is how a forwarded email becomes a way to lock the real owner out.
  */
  if (opts.invite?.alreadyActive) {
    return authShell('You already have an account', {
      heading: "You're already set up",
      card: `<p class="status" role="status">This ${escapeHtml(opts.invite.clientName)} account already has a password.
             Sign in with it.</p>
             ${signInButton(opts.appUrl)}
             <p class="note">Forgotten it? Press <strong>Forgot password?</strong> on the sign-in screen, or ask your
             administrator for a reset link. This invitation cannot change it.</p>`,
    })
  }

  if (opts.done) {
    return authShell(reset ? 'Password changed' : 'Account created', {
      heading: reset ? 'Password changed' : "You're in",
      card: `<p class="status" role="status" data-state="done">${
        reset ? 'Your new password is set. The old one no longer works.' : 'Your account is ready and your password is set.'
      }</p>
             ${signInButton(opts.appUrl)}
             <p class="note">Or open <a href="${escapeHtml(opts.appUrl)}">${escapeHtml(opts.appUrl)}</a> and sign in${reset ? ' with it' : ''}.</p>`,
      foot: `On a phone, use your browser's "Add to Home Screen" so Allstar opens full-screen and works without signal.`,
    })
  }

  if (!opts.invite) {
    return authShell('Link unavailable', {
      heading: 'This link has expired',
      sub: 'Links here work once. A password reset lasts two days and an invitation seven, and either stops working the moment a newer one is made.',
      card: `${signInButton(opts.appUrl).replace('class="primary"', 'class="primary" style="margin-top:0"')}
             <p class="note">Already have a password? Sign in with it. Forgotten it? Press <strong>Forgot password?</strong>
             on the sign-in screen for a fresh link, or ask your administrator for one.</p>`,
    })
  }

  /*
    Two passwords, compared on the server as well as by the browser — see
    `passwordPairError`. A typo in a password nobody can see is otherwise the
    first thing a person discovers at the next sign-in, and for a reset that
    is the sign-in they were already locked out of.
  */
  const first = escapeHtml(opts.invite.name.split(' ')[0] ?? '')
  const client = escapeHtml(opts.invite.clientName)
  return authShell(reset ? 'Reset your password' : 'Create your account', {
    heading: reset ? 'Reset your password' : 'Create your account',
    sub: reset
      ? `Choose a new password for your ${client} account.`
      : `${first ? `Welcome, ${first}. ` : 'Welcome. '}Set a password for your ${client} account to get started.`,
    card: `<form method="POST" action="/invite/${escapeHtml(opts.token)}" data-kind="${reset ? 'reset' : 'invite'}"
                 data-busy="${reset ? 'Changing password…' : 'Creating your account…'}">
       <label><span>Email</span>
         <span class="field"><input value="${escapeHtml(opts.invite.email)}" readonly autocomplete="username" inputmode="email"></span></label>
       ${passwordField({ name: 'password', label: reset ? 'New password' : 'Choose a password', placeholder: 'At least 10 characters', autofocus: true })}
       ${passwordField({ name: 'confirm', label: 'Type it again', placeholder: 'The same password' })}
       ${opts.error ? `<p class="alert" role="alert">${escapeHtml(opts.error)}</p>` : ''}
       <button type="submit" class="primary">${reset ? 'Change password' : 'Create account'}</button>
     </form>`,
    foot: 'Only you will know this password. Nobody at your company can see it.',
  })
}

/* --- privacy policy and support ------------------------------------------ */

/*
  Public, no sign-in: App Store Connect needs a Privacy Policy URL and a
  Support URL that anyone can open, and the app links to both. The policy
  says what this software actually collects and sends, and to whom — taken
  from the code, not a template. Counsel should review the wording before
  release (LAUNCH.md, blockers 6–9). The support address comes from the
  SUPPORT_EMAIL setting; without it the page says to ask the company's office.
*/
function docShell(title: string, body: string): Response {
  const res = shell(title, body)
  // Cacheable, unlike the account pages: nothing here is per-person.
  const headers = new Headers(res.headers)
  headers.set('cache-control', 'public, max-age=300')
  return new Response(res.body, { headers })
}

export function privacyPage(opts: { supportEmail?: string }): Response {
  const contact = opts.supportEmail
    ? `<a href="mailto:${escapeHtml(opts.supportEmail)}">${escapeHtml(opts.supportEmail)}</a>`
    : 'the office of the company that gave you your account'
  return docShell('Privacy Policy', `
<div class="mark">A</div>
<h1>Privacy Policy</h1>
<p class="sub">All Star field app · effective September 29, 2026</p>
<div class="doc">
<p>All Star is a field sales app used by home-improvement companies and their representatives. A company ("your company") creates accounts for its team; this policy explains what the app handles on your company's behalf.</p>
<h2>What we collect</h2>
<ul>
<li><b>Your account:</b> name, email, phone number, job title, profile photo, your role and team, and a password (stored only as a salted hash).</li>
<li><b>Your location:</b> precise location while the app is open, to show where you are on the map, to find nearby leads and to record where a visit took place. The app does not track you in the background.</li>
<li><b>Photos:</b> pictures you take or choose for a lead, and your badge photo. Saving your badge writes an image to your photo library only when you choose to.</li>
<li><b>Work records:</b> visits, outcomes, notes, appointments, tasks and routes you create.</li>
<li><b>Homeowner information:</b> addresses and any contact details your company imports or you enter, including Do Not Contact requests.</li>
<li><b>Technical data:</b> sign-in sessions and basic request logs used to keep the service working and secure.</li>
</ul>
<h2>How it is used</h2>
<p>Only to run the service for your company: showing leads and maps, recording field work, verifying a representative's badge for a homeowner, sending account emails, and reporting to your company. We do not sell personal information and do not use it for advertising.</p>
<h2>Who it is shared with</h2>
<ul>
<li><b>Your company</b>, which controls the data about its leads and team.</li>
<li><b>Service providers</b> that run parts of the app: Cloudflare (hosting and storage), Google Maps Platform (map display, place search, Street View, directions), Resend (account email), and, where your company turns them on, GoHighLevel (its CRM) and Geocodio (turning a map location into a street address).</li>
<li><b>Anyone who scans your badge QR code</b> sees your name, photo, company and whether your badge is current.</li>
</ul>
<p>Address data used to find houses in a territory comes from public and open datasets (Overture Maps, the U.S. National Address Database, and U.S. Census data). Postal town names for ZIP codes: © GeoNames, CC BY 4.0. City of Milwaukee addresses: © City of Milwaukee, CC BY.</p>
<h2>How long it is kept</h2>
<p>Your account data is kept while your account exists. Lead and work records belong to your company and are kept until your company deletes them. Homeowners who ask to be forgotten are erased, and stay erased.</p>
<h2>Your choices</h2>
<ul>
<li><b>Delete your account</b> at any time in the app: More → Edit profile → Delete my account. This removes your sign-in, profile, badge and your own visits, notes and photos; leads you worked stay with your company.</li>
<li>Location, camera and photo access can be turned off in your phone's Settings; parts of the app that need them will say so.</li>
<li>Homeowners can ask the company that contacted them to stop contacting them or to erase their information.</li>
</ul>
<h2>Children</h2>
<p>The app is for working adults and is not directed to children under 16.</p>
<h2>Contact</h2>
<p>Questions or requests: ${contact}.</p>
</div>`)
}

export function supportPage(opts: { supportEmail?: string }): Response {
  const email = opts.supportEmail
  return docShell('Support', `
<div class="mark">A</div>
<h1>Support</h1>
<p class="sub">All Star field app</p>
<div class="doc">
${email
    ? `<p>Email <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a> and include your company name and what you were doing. We aim to reply within one business day.</p>`
    : '<p>Contact the office of the company that gave you your account; they manage your sign-in and your team.</p>'}
<h2>Common questions</h2>
<ul>
<li><b>Forgot your password?</b> Tap “Forgot password” on the sign-in screen and follow the email.</li>
<li><b>Delete your account:</b> More → Edit profile → Delete my account.</li>
<li><b>Map or location not working:</b> check that location access is allowed for All Star in your phone's Settings.</li>
<li><b>Verify a representative:</b> scan the QR code on their badge.</li>
</ul>
<p><a href="/privacy">Privacy Policy</a></p>
</div>`)
}
