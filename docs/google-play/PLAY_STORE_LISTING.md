# Google Play store listing — Allstar Field 1.0.0

Paste-ready text for **Store presence → Main store listing**, written only from
what the app does today (checked against the code on 2026-10-13). Character counts
are measured, not estimated — `npm run verify:play-listing` re-checks
them after any edit.

The iOS listing draft is `docs/APP_STORE_LISTING.md`. The two are kept close on
purpose; the name difference is a company decision (`GOOGLE_PLAY_SETUP.md` §6).

---

## App name (30 max)

```
Allstar Field
```

## Short description (80 max)

```
Plan routes, knock doors and log every visit — even with no signal.
```

## Full description (4,000 max)

```
Allstar Field is the field app for door-to-door sales teams. Reps see their territory on a map, work a route house by house, and record what happened at every door in a few taps — with or without signal. The office sees the day as it happens.

FOR REPS IN THE FIELD
• Today's route, appointments and follow-ups on one screen
• A map of your leads, with the nearest door and turn-by-turn directions
• Record each visit: no answer, interested, follow-up, appointment, quote, sold or do not contact
• When a door says yes, pick the plan that was sold — the sale is priced from your company's price list
• Notes by voice or keyboard, photos of the property, and the homeowner's details
• Call, text or email a homeowner straight from the lead
• A digital team badge with a QR code homeowners can scan to verify you
• Works offline: everything is saved on the phone first and uploads when you have signal

FOR MANAGERS
• Pipeline, standings and team activity, updated through the day
• Every sale with its plan, value and the rep who closed it
• Leads, lists and territories assigned to the right reps

ON PHONES AND TABLETS
Allstar Field works on Android phones and tablets.

ACCOUNTS
Allstar Field accounts are created by your company. Ask your office for an invitation to sign in. You can delete your account at any time in the app (More → Edit profile → Delete my account) or on the web: https://allstar-api.josh-af6.workers.dev/delete-account

Privacy Policy: https://help.allstarhomesolutions.com/privacy
Terms of Use: https://help.allstarhomesolutions.com/terms
```

Things deliberately **not** claimed, because they are not true on Android today:

- Saving the badge image to the phone. The Android webview has no share sheet for
  files, so "Save image" explains that it cannot (iOS can).
- Push notifications, background location, or any feature for homeowners other
  than verifying a badge.

## Category and tags

| Field | Value |
|---|---|
| App category | **Business** |
| Tags (pick up to 5 in the Console) | Business, Productivity, Sales — choose from Google's list; the Console only offers its own tags |
| Contains ads | No |
| In-app purchases | No |

## Contact details (Store settings → Store listing contact details)

| Field | Value | Status |
|---|---|---|
| Email (required, public) | **Company provides** — a monitored support inbox | Missing |
| Website | `https://allstar-api.josh-af6.workers.dev/support` (or the company website) | Ready |
| Phone (optional) | Company provides, or leave blank | — |
| Privacy policy | `https://help.allstarhomesolutions.com/privacy` | Must be opened in a browser and checked before submitting — it could not be reached from the build environment |

Set the same support inbox as the Worker's `SUPPORT_EMAIL` setting so the public
support and delete-account pages show it (today they say "contact your office"
instead).

## Release notes — 1.0.0 (en-US, 500 max)

```
First release of Allstar Field for Android: your route, map, leads and visits in one app, with photos, voice notes, plans and sales — and everything saved on your phone when there's no signal.
```

## Graphics (in `docs/google-play/assets/`)

| Slot | File(s) | Spec Play enforces | Made from |
|---|---|---|---|
| App icon | `icon-512.png` | 512 × 512 PNG, ≤ 1 MB | The app icon (`apps/mobile/assets/images/icon.png`) |
| Feature graphic | `feature-graphic.png` | 1024 × 500, PNG/JPEG, no transparency | Brand lockup + the real Today screen |
| Phone screenshots | `phone/01…08-*.png` | 2–8, 1080 × 1920 (9:16), each side 320–3840 px, ≤ 2:1 | The app's built-in demo company |
| 7-inch tablet | `tablet-7in/01…08-*.png` | optional, 1200 × 1920 | same |
| 10-inch tablet | `tablet-10in/01…08-*.png` | optional, 1600 × 2560 | same |

Order and message, one per screenshot:

| # | Screen | Message |
|---|---|---|
| 1 | Today | The day's route, appointments and follow-ups |
| 2 | Map | Leads on a map, nearest door first |
| 3 | Leads | Every lead, searchable and filtered |
| 4 | A lead | Contact, history and plan, with Call / Text / Email / Navigate |
| 5 | Visit — "What happened?" | Record the outcome at the door |
| 6 | Visit — Sold | Pick the plan that was sold |
| 7 | Pipeline | The pipeline by stage |
| 8 | Standings | Where the team stands today |

All eight are real screens with the demo company's sample data (no real customers,
no invented statistics). The map draws the app's own street grid rather than
Google imagery, which keeps third-party map tiles out of the listing.
Regenerate after UI changes:

```bash
npm run build && npx vite preview --port 4173 &
node scripts/make-play-assets.mjs
```

A short promo video is optional and not prepared.

## Listing checklist

- [ ] Company decides the store name (Allstar Field vs. All-Star Field Sales)
- [ ] App name, short and full description pasted
- [ ] Icon, feature graphic, 8 phone screenshots uploaded; tablet sets uploaded
- [ ] Category Business; no ads; contact email set
- [ ] Privacy policy URL opens in a browser and covers Android (location, camera, microphone, deletion)
- [ ] Release notes added to the 1.0.0 release
- [ ] Store listing preview checked on a phone-sized window in the Console
