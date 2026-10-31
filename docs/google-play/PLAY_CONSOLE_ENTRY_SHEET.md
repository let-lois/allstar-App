# Play Console entry sheet — Allstar Field

The **Set up your app** tasks on the Dashboard, in the order the Console lists
them, each with the exact value to enter. Long text lives in the document named
beside each task; this sheet does not copy it, so there is one place to correct it.

Prepared by: Bea Capule · state of 2026-10-31 · app: `com.allstarhomesolutions.allstar`

Nothing here publishes the app. **Do not create a Production release** until the
company signs off (`ANDROID_RELEASE_CHECKLIST.md` §E).

## 0. Four things only the company can supply

Without these, the matching task cannot be finished honestly. None is invented here.

| Needed | Used in | Who |
|---|---|---|
| **A monitored support email** | Task 12 (contact details); also set it as the Worker's `SUPPORT_EMAIL` so the support and delete-account pages show it | Company |
| **A reviewer login** (an Allstar account with the field-rep role and a few sample leads) | Task 2 (App access). Google's reviewer cannot get past sign-in without it, and the app is rejected for it | Company creates it in Team → Add team member |
| **The store name**: "Allstar Field" or "All-Star Field Sales" | Task 13. Entered below as "Allstar Field"; change it in one place if the company decides otherwise | Company |
| **Confirmation that the privacy policy loads and covers Android** | Task 1. It could not be opened from the build environment | Bea opens it in a browser |

Checked today from the build environment: the public account-deletion page
`https://allstar-api.josh-af6.workers.dev/delete-account` and the support page
`/support` both load (HTTP 200). The privacy policy and terms could not be reached from here.

## 1. Set privacy policy

`https://help.allstarhomesolutions.com/privacy`

Open it in a browser first. It must load without signing in, name the company,
and cover location, photos, microphone/dictation (the phone's speech service
turns speech into text; the app keeps no audio), account deletion and retention.
If it does not, stop and send it to counsel — a policy that does not load is a rejection.

## 2. App access

Choose **All or some functionality is restricted**, then **Add new instructions**.
Text: `GOOGLE_PLAY_COMPLIANCE_AUDIT.md` §3 "App access". Fill in the reviewer's
email and password from §0. Do not put a real person's password here.

## 3. Ads

**No**, the app does not contain ads.

## 4. Content rating

Start the questionnaire, email = the support email.
Category: **Utility, productivity, communication, or other**.
Answers: `GOOGLE_PLAY_COMPLIANCE_AUDIT.md` §3 "Content rating". Everything No except:

- Users can interact or exchange content: **Yes** (team members see each other's notes and photos inside their company).
- Shares the user's location with other users: **No**.

Expected result: Everyone, with a "users interact" note.

## 5. Target audience and content

Age groups: **18 and over** only. The app is not designed for children and does
not appeal to them. (A work tool for employees.)

## 6. Data safety

Answers, one row per data type, with the code that proves each:
`GOOGLE_PLAY_COMPLIANCE_AUDIT.md` §3 "Data safety". In short:

- **Collected:** name, email, phone (optional), address (leads), precise location (optional), photos (optional), other user-generated content, other actions, diagnostics, device ID (Expo's random install id).
- **Not collected:** audio recordings, financial, health, messages, contacts, calendar, web browsing, files, installed apps.
- **Shared with third parties:** none. Service providers acting for the company (Cloudflare, Resend, Google Maps, Expo) are not "sharing" under Play's definitions.
- **Encrypted in transit:** Yes.
- **Users can request deletion:** Yes. URL: `https://allstar-api.josh-af6.workers.dev/delete-account`
- **Independent security review:** No.

One honest caveat for the deletion answer: encrypted backups are not pruned
(`GOOGLE_PLAY_COMPLIANCE_AUDIT.md` C5). The deletion page already says backups are
kept separately and not used to restore deleted accounts.

## 7. Government apps

**No.**

## 8. Financial features

**My app doesn't provide any financial features.**

## 9. Health

**My app doesn't have any health features.**

## 10. Advertising ID

**No**, the app does not use the advertising ID. (`com.google.android.gms.permission.AD_ID`
is not in the manifest — `npm run verify:android-release` pins this.)

## 11. News app, and anything else the Console adds

Answer **No** to News apps. If the Console shows a task not listed here, send
Bea a screenshot rather than guessing; the list changes.

## 12. Store settings: category and contact details

| Field | Value |
|---|---|
| App category | **Business** |
| Tags | Business, Productivity, Sales (only the ones Google's list offers) |
| Email | the support email from §0 |
| Website | `https://allstar-api.josh-af6.workers.dev/support` (or the company site) |
| Phone | optional; leave blank unless the company wants one |

## 13. Main store listing

Text, ready to paste, character counts checked by `npm run verify:play-listing`:
`PLAY_STORE_LISTING.md` — app name, short description, full description.

Graphics, in `docs/google-play/assets/`:

| Slot | File |
|---|---|
| App icon | `icon-512.png` |
| Feature graphic | `feature-graphic.png` |
| Phone screenshots (upload all 8, in order) | `phone/01-today.png` … `phone/08-standings.png` |
| 7-inch tablet | `tablet-7in/` (optional) |
| 10-inch tablet | `tablet-10in/` (optional) |

## 14. Before sending anything for review

- [ ] §0's four items are done.
- [ ] Every task on the Dashboard's "Set up your app" list shows complete.
- [ ] The Publishing overview page shows no errors.
- [ ] You have **not** created a Production release. Sending app content for review is a separate step the Console will offer; do it only when the company says go.

## What this does not change

Finishing these tasks does not by itself make the internal-testing link work. If
testers still see "Item not found", see the account checks in
`ANDROID_TESTING_PLAN.md` §2 and send Bea the tester list and the account the
Play Store app shows.
