# Google Play setup — Allstar Field

How to get from "no Play Console account" to "Allstar Field on the internal testing
track". Written for Bea, against this repository as it is on 2026-10-13. Every
technical value below was read from the code; anything that has to come from the
company is marked **Company provides**.

Companion files in this folder:

| File | For |
|---|---|
| `GOOGLE_PLAY_HANDOFF.md` | Start here: status board, who does what, exact next steps |
| `ANDROID_RELEASE_CHECKLIST.md` | Tick-list from build to production |
| `PLAY_STORE_LISTING.md` | Copy to paste into the store listing |
| `GOOGLE_PLAY_COMPLIANCE_AUDIT.md` | Data safety answers, policy risks |
| `ANDROID_TESTING_PLAN.md` | Internal → closed → production, and what to test |
| `assets/` | Icon, feature graphic and screenshots, ready to upload |

---

## 1. What the app is, technically

| Item | Value | Where |
|---|---|---|
| Framework | Expo SDK 57 (React Native 0.86), Expo Router; the field app is the web app running in a webview (`react-native-webview` 13.16.1, patched) | `apps/mobile` |
| Native project | Generated at build time by EAS ("prebuild"); there is no committed `android/` folder | `apps/mobile/.gitignore` |
| Package name | `com.allstarhomesolutions.allstar` (same as the iOS bundle ID) | `apps/mobile/app.json` |
| Version name | `1.0.0` | `app.json` → `version` |
| Version code | Managed by EAS (`appVersionSource: remote`), +1 per production build. First production AAB: **2** | `eas.json` |
| Target / compile SDK | 36 (Android 16) | React Native version catalog; pinned by `npm run verify:android-release` |
| Minimum SDK | 24 (Android 7.0) | same |
| Output | Android App Bundle (`.aab`) from the `production` profile | `eas.json` |
| Signing | EAS-managed keystore (already exists — it signed the earlier preview APKs). It becomes the **upload key**; Google holds the app-signing key (Play App Signing) | Expo account `let-lois`, project `all-star-app` |
| Updates | EAS Update, channel `production`, runtime `exposdk:57.0.0` | `app.json`, `eas.json` |
| Backend | Cloudflare Worker `https://allstar-api.josh-af6.workers.dev` (API, auth, mail via Resend), D1 database, R2 photo storage | `api/` |
| Push notifications | None. The app does not request `POST_NOTIFICATIONS` | — |
| Firebase / Google Play services SDKs | None | — |
| Crash reporting SDK | None. Server-side failed requests are logged with a request id (`api/src/observe.ts`) | — |

On-device name today: **All-Star** (`app.json` → `name`, shared with iOS). See
§6 for the naming decision.

## 2. Developer account (Company provides)

Register at <https://play.google.com/console/signup> as an **Organization**, not a
personal account. Reasons:

- The app belongs to the company and is used by its team; an organization account
  shows the company as the developer.
- Personal accounts created after 13 Nov 2023 must run a closed test with at least
  12 testers for 14 continuous days before production access. Google does not
  apply that rule to organization accounts. Confirm on the Console dashboard
  after registration: if a "Test your app with testers" task appears, it applies.

What registration needs (all **Company provides**; do not invent any of it):

| Item | Notes |
|---|---|
| Legal company name and address | Must match the D-U-N-S record exactly |
| D-U-N-S number | Required for organization accounts. Free from Dun & Bradstreet; can take up to ~30 days if the company has none. Apple's business account (Sean) needs the same number, so get it once |
| Organization website | Verified in the Console |
| Developer email and phone | Shown publicly on the listing (email) / used by Google (phone) |
| Contact name | The account owner; Google verifies identity |
| One-time registration fee | US$25, card in the company's name |
| Payments profile | Only needed for paid apps or in-app purchases. Allstar Field is free with neither, so **skip** |

After verification, add the team under **Users and permissions**:

| Person | Suggested access |
|---|---|
| Account owner (company) | Admin |
| Bea | "Release manager" style: manage store presence, testing tracks, releases; view app information |
| Sean | Admin or view-only, as the company decides |
| EAS Submit service account (§5) | Release to testing tracks only |

## 3. Create the app in the Console

**Home → Create app**:

| Field | Value |
|---|---|
| App name | `Allstar Field` (30 max) — see §6 |
| Default language | English (United States) – en-US |
| App or game | App |
| Free or paid | Free (cannot be changed to paid later) |
| Declarations | Developer Program Policies, US export laws: tick after reading |

Then **App content** (left menu → Policy → App content). Answers for every item
are in `GOOGLE_PLAY_COMPLIANCE_AUDIT.md` §3:

- Privacy policy URL
- App access (login required → reviewer credentials)
- Ads (No)
- Content rating questionnaire
- Target audience (18+)
- Data safety
- Government app (No), Financial features (None), Health (None)
- Account deletion URL: `https://allstar-api.josh-af6.workers.dev/delete-account`

Then **Store presence → Main store listing**: paste from `PLAY_STORE_LISTING.md`
and upload from `assets/`.

Then **Store settings**: category Business, contact email (Company provides),
website (optional).

## 4. The first build and the first upload

Google's publishing API cannot create the first release of a brand-new app, so the
**first AAB is uploaded by hand**. After that, EAS Submit can do it.

1. Build (already done once — build `e3129f4a`, see the handoff for its status):

   ```bash
   cd apps/mobile
   npx eas-cli build --platform android --profile production
   ```

   Or from the Expo dashboard → Builds → Create build → Android → `production`.
   The `.aab` link is on the build page.
2. Console → **Testing → Internal testing → Create new release**.
3. When asked about app signing, choose **Use Google-generated key** (Play App
   Signing). The EAS keystore that signed the AAB is registered as the upload key
   automatically from this first upload.
4. Upload the `.aab`, name the release `1.0.0 (2)`, paste the release notes from
   `PLAY_STORE_LISTING.md`, **Save → Review → Start rollout to Internal testing**.
5. Add testers (email list) under Internal testing → Testers; share the opt-in link.

### Protect the upload key

The upload keystore lives only in EAS. Someone with access to the Expo account
should download a copy once and keep it in the company password manager:

```bash
cd apps/mobile
npx eas-cli credentials -p android   # → production → Keystore → Download
```

If it is ever lost, Play can reset the upload key (Console → Setup → App
signing → Request upload key reset); the app-signing key Google holds is
unaffected. Never commit the keystore — `.gitignore` and
`verify:android-release` both guard against it.

## 5. EAS Submit for every release after the first (optional, recommended)

1. Google Cloud console → create (or reuse) a project → enable **Google Play
   Android Developer API**.
2. Create a service account; create a **JSON key** for it.
3. Play Console → Users and permissions → Invite new user → the service
   account's email → app access: Allstar Field → permissions: release to testing
   tracks (and production later, if wanted).
4. Upload the key to EAS, not to the repository:

   ```bash
   cd apps/mobile
   npx eas-cli credentials -p android   # → Google Service Account → Upload a key
   ```

5. Submit the latest production build to the internal track as a draft (the
   settings already in `eas.json`):

   ```bash
   npx eas-cli submit -p android --profile production --latest
   ```

   Drafts must be rolled out by hand in the Console. `releaseStatus: draft` is
   required until the app has been published once; it can change to `completed`
   after that if the team wants submissions to go live on the internal track
   automatically.

## 6. Decisions only the company can make

| Decision | Options | Recommendation |
|---|---|---|
| Store name | "Allstar Field" (this brief), "All-Star Field Sales" (the iOS listing draft, `docs/APP_STORE_LISTING.md`), or one name for both | One name on both stores. The Play title can differ from the iOS one, but people searching on both should find the same name |
| On-device name | "All-Star" today (`app.json` `name`, shared with iOS) | Leave it until the store name is settled; changing it needs a new build on both platforms |
| Distribution | Public listing vs. private | Play has no "unlisted" mode like Apple's. Options: public (anyone can install; only invited people can sign in), or **Managed Google Play** private app for the company's own Google Workspace / EMM devices only. Public is simpler for reps on personal phones |
| Countries | United States only, or wider | United States, matching the iOS plan |
| Tablets | Show the tablet screenshots | Yes — the app supports tablets and the screenshots exist |
| Reviewer account | A real sign-in Google can use | Create one dedicated reviewer account (field rep role) in the live company with a few sample leads; the same one Apple's review uses |
