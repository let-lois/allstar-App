# App Store listing — All-Star 1.0.0

Draft text and answers for App Store Connect, for build 10 (version 1.0.0,
iPhone and iPad). Everything here is ready to paste; the lines marked
**Decide** need someone at All Star to confirm before submitting.

Live pages the listing links to:

- Support: https://allstar-api.josh-af6.workers.dev/support
- Privacy Policy: https://allstar-api.josh-af6.workers.dev/privacy
- Terms of Use: https://allstar-api.josh-af6.workers.dev/terms
- License: Apple's standard EULA — https://www.apple.com/legal/internet-services/itunes/dev/stdeula/

---

## App information

| Field | Value | Limit |
|---|---|---|
| Name | **All-Star Field Sales** | 20 / 30 — includes the on-device name "All-Star" |
| Subtitle | **Door-to-door sales, organized** | 29 / 30 |
| Primary category | Business | |
| Secondary category | Productivity | |
| Content rights | Yes, contains third-party content (map imagery and address data), and we have the rights to use it | |
| Copyright | **2026 All Star Home Solutions** — **Decide:** the exact legal company name | |

## Pricing and availability

- Price: **Free** (no in-app purchases or subscriptions).
- Availability: **United States**.
- Distribution: **Decide — public or unlisted.** All-Star is used by one
  company with invite-only accounts. Unlisted (request it from Apple at
  https://developer.apple.com/contact/request/unlisted-app/) is the safer
  route through review; public works too, but a reviewer may question an app
  that nobody outside the company can sign up for.
- Release: **Decide — manual or automatic** after approval. Manual is
  recommended for a first release, so it goes live when the team is ready.

## Promotional text (170 max)

> Plan the day, knock the doors and record every outcome — even with no signal. Leads, routes, appointments and sales for your field team, on iPhone and iPad.

## Description (4,000 max)

> All-Star is the field app for door-to-door sales teams. Reps see their territory on a map, work a route house by house, and record what happened at every door — in a few taps, with or without signal. The office sees the day as it happens.
>
> FOR REPS IN THE FIELD
> • Today's route, appointments and follow-ups on one screen
> • A map of your leads, with the nearest door and turn-by-turn directions
> • Record each visit: no answer, interested, follow-up, appointment, quote, sold or do not contact
> • When a door says yes, pick the plan that was sold — the sale is priced from your company's price list
> • Notes by voice or keyboard, photos of the property, and the homeowner's details
> • Call, text or email a homeowner straight from the lead
> • A digital team badge with a QR code homeowners can scan to verify you
> • Works offline: everything is saved on the device first and uploads when you have signal
>
> FOR MANAGERS
> • Pipeline, standings and team activity, updated through the day
> • Every sale with its plan, value and the rep who closed it
> • Leads, lists and territories assigned to the right reps
>
> ON IPHONE AND IPAD
> All-Star works on iPhone and iPad, in portrait and landscape on iPad.
>
> ACCOUNTS
> All-Star accounts are created by your company. Ask your office for an invitation to sign in. You can delete your account at any time in the app: More → Edit profile → Delete my account.
>
> Privacy Policy: https://allstar-api.josh-af6.workers.dev/privacy
> Terms of Use: https://allstar-api.josh-af6.workers.dev/terms
> License Agreement: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/

## Keywords (100 max, no spaces after commas)

```
canvassing,d2d,leads,route,territory,crm,knock,canvass,appointments,pipeline,map,quote,team,rep
```

95 / 100. None of these repeat a word from the name or subtitle.

## URLs

| Field | Value |
|---|---|
| Support URL | https://allstar-api.josh-af6.workers.dev/support |
| Marketing URL | (optional — leave blank, or the company website) |
| Privacy Policy URL | https://allstar-api.josh-af6.workers.dev/privacy |

## Age rating

Answer **None / No** to every content question (violence, profanity, mature
themes, gambling, contests, medical, alcohol and so on). For "Unrestricted
web access": **No**. For user-generated content: **No** — notes and photos are
private to the company, never public. Result: **4+**.

## App Privacy ("Data Types")

Data is collected: **Yes**. None of it is used for tracking, and none is used
for advertising. Every type below is **linked to the user's identity**, used
for **App Functionality** only.

| Category | Type | Why |
|---|---|---|
| Contact Info | Name | The rep's profile and badge |
| Contact Info | Email Address | Sign-in and account email |
| Contact Info | Phone Number | The rep's profile (optional) |
| Location | Precise Location | The map, nearest doors, and where a visit was recorded — only while the app is open |
| User Content | Photos or Videos | Property photos and the badge photo |
| User Content | Other User Content | Visit notes, outcomes, and homeowner details reps enter |
| Identifiers | User ID | The account id that ties work to the rep |
| Diagnostics | Other Diagnostic Data | Failed requests are logged with the account and the action, so support can trace a problem |

Not collected: contacts from the address book, browsing history, purchases,
financial info, health, audio (dictation is turned into text by Apple's
speech recognition; the app never records or uploads audio itself).

> Note: the in-app privacy manifest (build 10) lists the first seven. The
> diagnostics line should be added to `ios.privacyManifests` in `app.json`
> with the next build so the two match exactly.

## Encryption (export compliance)

Declared in the build (`ITSAppUsesNonExemptEncryption: false`). If asked:
**No** non-exempt encryption — the app only uses HTTPS.

## App Review information

- **Sign-in required: Yes.** Provide a working account.
  **Decide/create:** a reviewer account in the live All Star account (for
  example `appreview@…`, role Field Rep), with a handful of real-looking leads
  assigned to it. Remove the Austin and Denver test leads first, since the
  reviewer will see whatever that account can see.
- Contact: name, phone and email of the person who answers Apple's questions.
- Notes (paste and fill in the login):

> All-Star is a field sales app used by All Star Home Solutions and its door-to-door team. Accounts are created by the company — there is no public sign-up — so please use this account:
>
> Email: [reviewer email]
> Password: [reviewer password]
>
> What to try: Today shows the day's route and appointments. Map shows the rep's leads. Open a lead and tap Start visit to record an outcome; choosing Sold asks which plan was sold. Notes can be dictated with the microphone button.
>
> Location: used while the app is open to show the rep's position on the map, order the route from where they stand, and record where a visit happened. There is no background location.
>
> Account deletion: More → Edit profile → Delete my account (screenshot attached). It asks for the password and for the word DELETE, then removes the account.
>
> The app supports iPhone and iPad. There are no in-app purchases.

Attach `review-03-delete-account.png` and `review-04-delete-confirm.png`
from the screenshot set to the review notes.

## Screenshots

Taken from the app at Apple's required sizes, with sample data (no real
customers). Upload in this order:

| # | Screen | iPhone 6.9" (1320 × 2868) | iPad 13" (2064 × 2752) |
|---|---|---|---|
| 1 | Today — route, appointments, follow-ups | `iphone-6.9/01-today.png` | `ipad-13/01-today.png` |
| 2 | Map of leads | `02-map.png` | `02-map.png` |
| 3 | Leads list (iPad: list beside the lead) | `03-leads.png` | `03-leads.png` |
| 4 | A lead — contact, call/text/email, plan | `04-lead.png` | `04-lead.png` |
| 5 | Visit — "What happened?" | `05-visit-outcome.png` | `05-visit-outcome.png` |
| 6 | Sold — "Which plan?" | `06-visit-sold-plan.png` | `06-visit-sold-plan.png` |
| 7 | Pipeline | `07-pipeline.png` | `07-pipeline.png` |
| 8 | Standings | `08-standings.png` | `08-standings.png` |

No screenshot carries words like "free" or prices other than sample plan
prices shown inside the app.
