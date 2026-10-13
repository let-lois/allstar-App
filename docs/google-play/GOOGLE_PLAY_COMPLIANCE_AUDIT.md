# Google Play compliance audit — Allstar Field 1.0.0

Evidence-based: every row cites the code that establishes it. Checked
2026-10-13 against `main` plus the Android release branch. "Verified" means read
in code or exercised by a test here; "Unverified" means it needs a person, a
device or a page this environment could not reach.

## 1. Summary — what could cause a rejection

| # | Issue | Severity | Status |
|---|---|---|---|
| C1 | Privacy policy at `https://help.allstarhomesolutions.com/privacy` could not be opened from the build environment (network policy). It must load publicly, name the company, and cover location, photos, microphone/dictation, account deletion and retention | **Blocker** | Unverified — Bea/counsel to open and review |
| C2 | Account deletion web URL | Was a blocker | **Fixed** in this branch: `GET /delete-account` (public page; deploys when the branch is merged) |
| C3 | Login required: Google's reviewers need working credentials, or the review is rejected for "App access" | **Blocker** | Company must create a reviewer account |
| C4 | Developer contact email is required and `SUPPORT_EMAIL` is not set on the Worker, so the public support page has no address | High | Company provides the inbox; set it as the Worker's `SUPPORT_EMAIL` |
| C5 | Encrypted database backups in R2 are never pruned (`docs/BACKUPS.md`: "Nothing prunes them"), so a deleted account survives in old backups indefinitely. Play's Data safety asks whether data is deleted on request; the honest answer today needs that caveat | Medium | Needs an ops decision: an R2 lifecycle rule (e.g. 35–90 days) on the backups bucket. Not changed here (production change, needs authorization) |
| C6 | Android has never been confirmed to boot and run on a physical device after the webview bridge patch (#158). A black screen at review is a "broken functionality" rejection | **Blocker until tested** | Internal-testing QA (`ANDROID_TESTING_PLAN.md`) |
| C7 | Google Maps key restrictions: if the key is restricted by HTTP referrer, the Android webview (loaded from `file://`) may be refused and the map stays blank | Medium | Verify on device; adjust the key's restrictions in Google Cloud if needed |

Nothing in the app uses ads, the advertising ID, background location, SMS/Call
Log, accessibility services, `QUERY_ALL_PACKAGES`, exact alarms, foreground
services, or broad media/file access — the policy areas that most often trigger
extra declarations.

## 2. Permissions (merged manifest)

Read from `npx expo prebuild --platform android` plus every library manifest
(`apps/mobile/node_modules/**/src/main/AndroidManifest.xml`). Pinned by
`npm run verify:android-release`.

| Permission | Why | Runtime prompt | Policy notes |
|---|---|---|---|
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Order the route from where the rep stands; record where a visit started (`visits.start_lat/lng/accuracy`) | Yes, when the map/route first asks (react-native-webview `geolocationEnabled`) | Foreground only. No `ACCESS_BACKGROUND_LOCATION`, so no location declaration form |
| `RECORD_AUDIO` | Note dictation via Android's speech recognizer (`expo-speech-recognition`, `apps/mobile/src/lib/dictation.ts`) | Yes, on first mic tap | Audio is not recorded or uploaded by the app; only the recognized text is kept, and only if the rep saves the note |
| `INTERNET`, `ACCESS_NETWORK_STATE` | API, updates, images | No | Normal |
| `VIBRATE` | Expo template default | No | Normal, harmless |
| ~~`READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`~~ | Removed (`android.blockedPermissions`) — photos come through the system file chooser or the camera app into app-private storage (`getExternalFilesDir`, `RNCWebViewModuleImpl.java`) | — | — |
| ~~`SYSTEM_ALERT_WINDOW`~~ | Removed — nothing draws over other apps | — | — |
| `CAMERA` | **Not declared**, deliberately: react-native-webview launches the camera app with `ACTION_IMAGE_CAPTURE`, which needs no permission when the app does not declare it (see the #158 commit note) | The camera app's own UI | No camera permission line in Data safety |

Other manifest facts: `allowBackup="false"` (session token and homeowner data
are not copied to cloud backups), one exported activity (launcher + the
`allstar://` scheme), no `android:usesCleartextTraffic` (cleartext is off by
default at targetSdk 36; all traffic is HTTPS), no Android App Links
(`autoVerify`) — none are needed; the app has no web links that should open in it.

## 3. Play Console "App content" answers

### Privacy policy
`https://help.allstarhomesolutions.com/privacy` (the app's `/privacy` route
redirects there). See C1.

### App access
"All or some functionality is restricted" → add instructions:

> Allstar Field is used by companies that sell door to door. Accounts are created
> by the company; there is no public sign-up. Sign in with:
> Email: [reviewer email] · Password: [reviewer password]
> Today shows the day's route and appointments; Map shows the rep's leads; open a
> lead and tap Start visit to record an outcome; choosing Sold asks which plan was
> sold. Location is requested when the map opens; the microphone only when you tap
> the mic in a note.

### Ads
No, the app does not contain ads. No ad SDK is present; `com.google.android.gms.permission.AD_ID` is not declared.

### Content rating (IARC questionnaire)
Category: **Utility, productivity, communication, or other**. Answer No to
violence, sexuality, language, controlled substances, gambling. Two questions need
a deliberate answer:

- *Users can interact or exchange content*: **Yes** — team members see each
  other's notes, photos and visit history inside their company. It is not public
  and there is no chat with strangers.
- *Shares the user's current location with other users*: **No** — a visit's
  start position is stored, but no live location is shown to other people.
  (Managers do see which leads were visited; if the company considers that
  location sharing, answer Yes.)

Expected result: Everyone / PEGI 3-equivalent, with an "Users interact"
interactive element.

### Target audience and content
Age groups: **18 and over** only. Not designed for children; no appeal to
children in the listing. (A work app for employees.)

### Government app / Financial features / Health
No / none / none.

### Data safety

Collected = leaves the device to our servers or a service provider. Nothing is
**shared** with third parties for their own use; service providers acting for us
(Cloudflare hosting, Resend email, Google Maps/geocoding, Expo updates) do not
count as sharing under Play's definitions. Nothing is used for advertising or
sold. **All data is encrypted in transit** (HTTPS only).

| Data type | Collected | Required / optional | Purposes | Evidence |
|---|---|---|---|---|
| Personal info → Name | Yes | Required | App functionality, Account management | `users.first_name/last_name/name`; homeowner names on leads |
| Personal info → Email address | Yes | Required | App functionality, Account management, Developer communications (invites, resets) | `users.email`; `api/src/mailTemplates.ts` |
| Personal info → Phone number | Yes | Optional | App functionality | `users.phone`; homeowner phone on contacts |
| Personal info → Address | Yes | Required | App functionality | Lead (homeowner) addresses — the core record |
| Location → Precise location | Yes | Optional (app works without it, less well) | App functionality | `visits.start_lat/lng/accuracy` |
| Photos and videos → Photos | Yes | Optional | App functionality | Property photos in R2; profile/badge photo in `users.avatar_url` |
| Audio → Voice or sound recordings | **No** | — | — | Dictation returns text only; the app never stores or uploads audio. The speech recognition itself is performed by the phone's speech service (Google), which the privacy policy should mention |
| App activity → Other user-generated content | Yes | Required | App functionality | Visit outcomes, notes, tasks, appointments |
| App activity → Other actions | Yes | Required | App functionality, Analytics (team standings) | `audit_log`, `users.last_seen_at`, `daily_stats` |
| App info and performance → Diagnostics | Yes | Required | App functionality (troubleshooting) | Failed requests logged with request id and account (`api/src/observe.ts`, `error_log`) |
| Device or other IDs | Yes | Required | App functionality | `expo-updates` sends a random per-install UUID (`EAS-Client-ID`, `expo-eas-client`) to Expo's update server. Not linked to the account |
| Financial info, Health, Messages, Contacts (address book), Calendar, Web browsing, Files and docs, Installed apps | No | — | — | Not accessed |

Security answers:

- Data encrypted in transit: **Yes**.
- Users can request deletion: **Yes** — in app, on the web, and via the
  company's administrator; URL `https://allstar-api.josh-af6.workers.dev/delete-account`.
- Independent security review: No.

Ephemeral processing: Not claimed for any collected type.

### Account deletion

| Requirement | Status | Evidence |
|---|---|---|
| In-app deletion | ✅ More → Edit profile → Delete my account (password + typing DELETE) | `src/screens/MyProfile.tsx`, `api/src/users.ts` `deleteOwnAccount`, `smoke:account-delete` |
| Web deletion without the app | ✅ (after merge) sign in on the web console → Edit profile → Delete my account; or an administrator deletes from Team → Manage | `GET /delete-account`, `api/src/pages.ts` `deleteAccountPage` |
| What is deleted | User row and everything keyed to it by `ON DELETE CASCADE`: sessions, visits, notes, tasks, appointments, routes, activity, daily stats, territory memberships, profile/badge photo (stored in the row) | `api/schema.sql` |
| What is kept | Company-owned leads (unassigned), property photos, sales records (rep set to null), one audit-log entry (name, email, role); encrypted backups (see C5) | `api/schema.sql`, `api/src/users.ts` |

## 4. Third-party services the app talks to

| Service | From | What it receives | Role |
|---|---|---|---|
| Cloudflare (Workers, D1, R2) | App ↔ API | Everything the app stores | Hosting / processor |
| Google Maps JavaScript API, Street View, Places | The webview | Map viewport, address search text, the device's IP | Service provider; Google's own terms apply |
| Google Geocoding, Geocodio | The Worker (server side) | Addresses being geocoded | Service provider |
| MapTiler | The Worker, proxied | Map tile coordinates only | Service provider |
| Resend | The Worker | Recipient name/email and email body (invites, resets, notices) | Service provider |
| Expo (EAS Update) | The app | Runtime version, platform, random install id | Service provider |
| Android speech recognition (Google) | The phone OS | Audio while the mic is on | OS service, not an SDK in the app |
| GoHighLevel | The Worker, only if the company connects its own CRM | Lead/contact details the company syncs | The company's own system; disclose in the privacy policy |

No analytics, crash-reporting, attribution or advertising SDK is bundled
(`apps/mobile/package.json`).

## 5. Security

| Item | Status | Evidence |
|---|---|---|
| Transport | HTTPS only; no cleartext | Worker on `workers.dev`; Android default at targetSdk 36 |
| Passwords | PBKDF2 (100k iterations) + pepper; never shown to admins | `api/src/auth.ts`; PR #193 |
| Password reset | Single-use hashed token, 2-day expiry, token kept out of URLs and logs | `api/src/users.ts`, `api/src/pages.ts` `resetPage` |
| Sessions | Server-side, revocable; revoked on password change and deactivation | `api/src/auth.ts`, `api/src/users.ts` |
| Webview debugging | Off in production builds | `apps/mobile/src/lib/inspectable.ts`, `verify:inspectable` |
| Navigation | The webview only loads the app's own bundle; other links open outside | `apps/mobile/src/app/index.tsx` `onShouldStartLoadWithRequest`, `verify:handoff` |
| On-device data | IndexedDB in the app sandbox; excluded from Android backup | `app.json` `allowBackup: false` |
| Secrets in repo | None; keystores and Play keys git-ignored and checked | `verify:android-release` |

## 6. Remaining actions

1. Company/counsel: review the privacy policy for Android (C1) and confirm it loads.
2. Company: create the reviewer account (C3) and the support inbox (C4); set `SUPPORT_EMAIL` on the Worker.
3. Ops decision: backup retention (C5).
4. QA: the device tests in `ANDROID_TESTING_PLAN.md` (C6, C7) before production.
5. Merge the branch so `/delete-account` is live before the Data safety form is submitted.
