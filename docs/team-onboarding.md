# Team Member Onboarding — implementation report

Status: **implemented end to end, gated, on branch `claude/mobile-first-field-sales-kflg1x`.**
Nothing in production changes until the Worker and Pages deploy; the schema
migrations (015–019) run on the Worker's first request after deploy and are
guarded per statement, so a partial earlier run cannot wedge them.

## What was there already, and what this added

| Area | Before | Now |
| --- | --- | --- |
| Accounts | `users` with `name`, `role`, `active`, `password_hash`; invite tokens shared with reset links | Same tables, extended: first/last name, title, team, onboarding and badge facts, `last_seen_at`; invites carry `kind` and `revoked_at` |
| Invitations | One link per person; a second invite made a second row; no email | One canonical row per person per company; re-invite merges and re-mints; email through MailChannels when configured, link-only otherwise |
| Self sign-up | None | Company join code / link, admin-controlled, rate-limited, field-rep only |
| Onboarding | None | Five-step flow, server-held state, resumable, one shared flow for both ways in |
| Badge | None | Permanent 8-digit id minted once, 1-year expiry, confirmation timestamp, QR to the badge's public verification page, admin renew / regenerate |
| Console roster | Name, status dot, role, performance numbers | People view with Invitation / Account / Onboarding / Badge / Last active / Date added, filters, and a Performance view with the old numbers |
| Company settings | Outcomes, notes, photos, reporting, integrations, geocoding | + Company tab: logo, website, badge QR code link, join link, teams |

Existing features reused rather than duplicated: the invite/accept pages,
`guard()` for every admin action, the roster held in the store and cached in
IndexedDB, the avatar picker and outbox for the profile photo, the coach-mark
tour (offered from the walkthrough), the audit log, `verify:api-access` for
every new route.

## Database changes (D1)

Migrations, all idempotent and guarded per statement:

- `015-teams` — `teams(id, client_id, name, created_at)`, unique on `(client_id, lower(name))`.
- `016-users-onboarding` — `users` + `first_name, last_name, job_title, team_id, onboarding_step, onboarding_version, onboarding_completed_at, walkthrough_completed_at, setup_completed_at, location_status, badge_id, badge_issued_at, badge_expires_at, badge_confirmed_at, last_seen_at`; unique `badge_id`.
- `017-invites-kind` — `invites` + `kind ('invite' | 'reset')`, `revoked_at`.
- `018-clients-company` — `clients` + `logo_url, website, join_code, join_code_created_at`; unique `join_code`.
- `019-onboarding-backfill` — everyone who already had a password is marked onboarded at version 1 as of their `created_at`, so no working rep is thrown into the flow.
- `020-clients-badge-qr` — `clients` + `badge_qr_url`: the link every badge's QR code encodes; NULL means the badge's own verification page.

Statuses are **derived, never stored**: `api/src/onboarding.ts` computes
invitation, onboarding and badge status from the facts above, on every read.

## API

New or changed routes (all declared in `verify:api-access`):

- `POST /api/join` — public, rate-limited; redeem a company code, create or claim the account, sign in.
- `GET|POST|DELETE /api/join-link` — admin; read, rotate, disable the code.
- `POST /api/invites` — widened input (first/last/title/team); one canonical row; re-invite merges.
- `POST /api/invites/:userId/resend|revoke` — admin.
- `GET|POST /api/teams`, `PATCH|DELETE /api/teams/:id` — admin.
- `POST /api/company` — admin; website (normalised, https assumed) and logo (data URL ≤ 64 KB); `null` clears.
- `GET /api/verify?badge=NNNNNNNN` — public, rate-limited per caller; answers active / expired / pending / inactive with the name, photo, title and company, 404 for an unknown number. The badge's QR code opens `/verify/NNNNNNNN` on the app, which renders this before any sign-in.
- `GET /api/me` — now the full person: onboarding block, badge, company.
- `GET /api/me/onboarding`, `POST /api/me/onboarding/step`, `PATCH /api/me/profile`, `POST /api/me/badge`, `POST /api/me/badge/confirm`, `POST /api/me/badge/renew` — session.
- `POST /api/users/:id/team|title|onboarding-reset|badge-renew|badge-regenerate` — admin, through `guard()`.
- `GET /api/users` — roster rows carry the derived statuses, team, title, invited/created/last-seen times.
- Login and bootstrap return the same full user; the founder created at `/setup` is onboarded by definition.

Fixed along the way: an admin setting a pending account's password left it
inactive; login for an email that exists in two companies.

## Field app

- **Sign in / Create account** on the Login screen; `/join/CODE` links prefill the code.
- **Onboarding shell** replaces the app for any live user whose server-side onboarding is not complete; opens at the step the server holds (second device, reload, interrupted).
- **1 Profile** — only what is missing is asked loudly; admin-entered values prefilled and editable; email, role and team locked; photo through the outbox.
- **2 App setup** — location asked once via a button, never on arrival, never re-asked once granted; Add to Home Screen via the install prompt or iOS instructions; camera explained as ask-on-use. Notifications deferred until push exists.
- **3 Learn the basics** — five cards (Map & Territory, Knock a Door, Log the Result, Manage Leads, Track Performance), ~60 s, with the full tour offered at the end.
- **4 Badge** — minted once on first open; the id never changes on view; **Confirm badge information** records a timestamp. The QR code draws the company's own QR link when the admin has set one in Company settings (in GoHighLevel: the sub-account's Sites → QR Codes; paste the link the latest code points to), so scans land and count where the company already tracks them; with no link set it opens the badge's public verification page, so a badge is scannable from day one. The website, when set, is a link on the verification page. Confirmation is disabled until the person has a profile photo — the card shows where the face goes and offers **Add your photo**, which returns to the profile and back.
- **Badge design** — one component, `TeamBadge`, everywhere a badge is drawn (onboarding, My badge, the admin's sample, the public verification page): white portrait card with rounded corners, blue header with a lanyard slot and **TEAM MEMBER**, the company logo (or the company name in bold caps when there is no logo), a large softly-rounded photo (placeholder until one exists), name and title in bold caps, and a bottom row with **ID / ISSUED / EXPIRES** on the left and the QR code on the right. Expiry is one year from issue.
- **5 Ready-to-sell checklist** — every line is the server's; required vs recommended is the server's; Complete is disabled until the server says it can.
- **6 You're ready** — Start knocking → map (reps) or Today (office).
- **More** — My badge (create / confirm / renew), Edit profile (name, phone, title).
- **Today** — a dismissible card for people from before badges existed.

## Admin console

- **Team → People**: Name, Role · title, Team / office, Invitation (Not sent / Pending / Accepted / Expired / Revoked), Account (Active / Invite pending / Deactivated), Onboarding (Not started / In progress / Complete / Update required), Badge (Not created / Awaiting confirmation / Active / Expired), Last active, Date added. Filters: Invite open, Still setting up, Badge not active, Removed from team; search by name, email or team.
- **Team → Performance**: the previous table (today, doors, contact rate, won, range).
- **Manage a person**: re-send / revoke invite, team, title, reset onboarding, renew / regenerate badge, role, access, password / reset link, delete. Actions appear only where the server would allow them; managers see statuses but hold none of the admin levers.
- **Settings → Company**: logo, website (with a live sample badge), self sign-up code and link (change / turn off / turn on), teams (add / rename / delete).
- **Add team member**: email required; first, last, title, team optional; says whether the invite was emailed or only linked.

## Invitation, onboarding and badge workflows

- Admin adds a person → one `users` row (`active = 0`, no password) + one invite token → email if configured. Send twice, or invite an existing email: the same row; a pending invite is re-minted (old link revoked), an existing member gets the fields they were missing and no link.
- Rep downloads first → Create account with the company code → if an invite for that email is pending it is claimed; otherwise a field-rep row is created → onboarding opens at the profile.
- Onboarding state lives on the server; the phone posts each step; order is enforced; a reset by an admin signs the person out and reopens the flow with their data intact; a new `ONBOARDING_VERSION` reopens it for everyone ("Update required").
- Badge id is minted once (retry on collision), expires after `BADGE_VALID_DAYS = 365`; renew keeps the id, regenerate changes it; both clear confirmation so the rep confirms again.

## Files

Worker: `api/schema.sql`, `api/src/migrate.ts`, `api/src/onboarding.ts` (pure rules), `api/src/onboardingFlow.ts`, `api/src/me.ts`, `api/src/teams.ts`, `api/src/company.ts`, `api/src/join.ts`, `api/src/mail.ts`, `api/src/mailTemplates.ts`, `api/src/invites.ts`, `api/src/users.ts`, `api/src/auth.ts`, `api/src/read.ts`, `api/src/pages.ts`, `api/src/index.ts`, `api/src/types.ts`, `api/wrangler.toml`.

Field app: `src/onboarding/*` (shell + 6 steps), `src/screens/Login.tsx`, `src/screens/MyBadge.tsx`, `src/screens/MyProfile.tsx`, `src/screens/More.tsx`, `src/screens/Today.tsx`, `src/components/badge/{TeamBadge,BadgeNudge}.tsx`, `src/lib/{qr,install,geo,http,session}.ts`, `src/data/walkthrough.ts`, `src/store/useAppStore.ts`, `src/types.ts`, `src/App.tsx`, `src/main.tsx`.

Console: `src/admin/{AdminTeam,ManageUser,AddMemberDialog,CompanyPanel,AdminSettings,statusLabels}.tsx`.

Gates: `scripts/verify-{onboarding,badge,roster,invite,lists-e2e,dnc,console-access}.mjs`, `scripts/lib/onboarding-mock.mjs`; `api/scripts/{verify-onboarding-status,smoke-team-model,smoke-onboarding-schema,smoke-onboarding-flow,smoke-onboarding-steps,smoke-mail,smoke-onboarding}.mjs`.

## Environment variables and manual configuration

Worker secrets / vars (operator, never in the repo):

- `MAILCHANNELS_API_KEY` — MailChannels transactional API key. Without it invites are link-only and the console says so.
- `MAIL_FROM` — `"Allstar <no-reply@yourdomain.com>"`; the domain needs MailChannels' SPF / Domain Lockdown DNS records.
- `MAIL_BASE_URL` — optional override of the MailChannels endpoint (tests point it at a stub).
- `APP_URL` — the public app origin used in emails and join links (defaults to `https://allstar.letlois.com`).

In the console after deploy: Settings → Company — upload the logo, set the
website (linked from every badge's verification page), turn on self
sign-up if wanted, create teams; Team → Add team member for existing staff
who should have a badge, or let them use My badge from More.

Dependency added: `qrcode-generator` (MIT, no dependencies, runs on the phone).

## Verification

- 71 browser/static gates (`npm run verify:all`), including new `verify:onboarding`, `verify:badge`, `verify:roster`; each new gate was sabotage-proved (a deliberate break fails the assertion it guards).
- 29 API smokes against real D1 (`cd api && npm run smoke:all`), including the migration-from-baseline smoke, the two-tenant login case, rate limiting on `/api/join`, and the full step machine.

## Known gaps and next improvements

- No email-change action for admins (not in the brief; a rep's email is the account key and would need a re-verification flow).
- Push notifications do not exist yet, so the Setup step does not ask for notification permission.
- The walkthrough cards are static; the live 22-step tour is offered as the optional deep version.
- MailChannels is a paid plan since 2024; the adapter is behind an interface, so another provider is one file.
- `verify:no-emoji` still allows five icon characters in older screens; unrelated to onboarding.
