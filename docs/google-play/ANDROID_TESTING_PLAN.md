# Android testing plan — Allstar Field

Internal testing → (closed testing, if the account requires it) → production.
Nothing reaches the public without the company's explicit go-ahead.

## 1. Which testing rule applies

| Account type | Rule | Plan |
|---|---|---|
| **Organization** (recommended) | No mandatory closed test. Internal testing is enough to start; production access is available once the app content and listing are complete | Internal testing for at least a week of real field use, then production |
| **Personal**, created after 13 Nov 2023 | Closed test with **at least 12 opted-in testers for 14 continuous days** before you can apply for production | Recruit 15+ reps (margin for drop-outs), keep them opted in for 14 days, then apply |

Check the Console dashboard after the account is verified: if the "Test your
app with testers" task appears, the personal-account rule applies.

## 2. Tracks

| Track | Who | Size | Review | Use |
|---|---|---|---|---|
| Internal testing | Named emails (up to 100) | Bea, office staff, 3–5 reps with different phones | Minutes, no full review | Every build first |
| Closed testing | Email list or Google Group | The wider team | Full review | Only if required (§1), or a staged team pilot |
| Production | Everyone in the chosen countries | — | Full review | After the exit criteria in §6 |

### Inviting testers

1. Console → Testing → Internal testing → **Testers** → Create email list
   (e.g. "Allstar internal") → add each tester's **Google account email** (the one
   signed in to Play Store on their phone).
2. Copy the **opt-in link** from the same page and send it with:
   - "Open this on your Android phone, tap *Become a tester*, then *Download it on Google Play*."
   - Their Allstar Field sign-in (the company invites them from Team → Add team member).
3. Testers must stay opted in; leaving the program removes them from the count
   for the 14-day rule.

## 3. Device matrix

At least one of each before production:

| Kind | Example | Why |
|---|---|---|
| Recent Pixel, Android 16 | Pixel 8/9 | The target SDK; edge-to-edge and predictive back are enforced |
| Samsung, Android 14–15 | Galaxy A-series | Most common reps' phone; Samsung keyboard and gesture nav |
| Older/low-RAM, Android 10–12 | Moto G / Galaxy A1x | WebView performance, IndexedDB under memory pressure |
| Tablet, 10-inch | Galaxy Tab | At targetSdk 36 Android ignores the portrait lock on large screens, so the app **will rotate** on tablets |
| Android 7–9 (optional) | any | The minimum SDK is 24; check it at least boots |

## 4. Test cases

Run on the internal-testing build installed from Play (not a side-loaded APK — the
Play-signed build is what matters).

### P0 — must pass (any failure blocks production)

| # | Test | Pass when |
|---|---|---|
| A1 | Install from the internal-testing link and open | Splash, then the sign-in screen. **No black screen** (the historic Android failure, P0-1 in `docs/MOBILE_READINESS.md`) |
| A2 | Sign in with a real account | Today loads with the rep's route |
| A3 | Force-close and reopen | Still signed in (session in IndexedDB survives) |
| A4 | Status bar and navigation bar | Nothing important hidden under the status bar or the gesture/3-button nav bar on Today, Map, Leads, a lead, a visit, More (edge-to-edge is enforced at targetSdk 36; the web app draws its own safe areas) |
| A5 | Location prompt | Appears when the map opens; Allow → the blue dot and "Nearest door" work. Deny → the app still works and says location is off |
| A6 | Map | Google map tiles draw (if they do not, the Maps key's restrictions refuse the webview — see compliance C7) |
| A7 | Record a visit end to end | Start visit → outcome → Sold → plan → Complete; it appears on the lead and in Pipeline |
| A8 | Photos | Take a photo from a lead (camera app opens without a permission prompt) and pick one from the gallery; both upload and show |
| A9 | Offline | Airplane mode → record a visit → reconnect → it syncs without duplicates |
| A10 | Back button / gesture | Inside a lead form goes back; at Today it leaves the app; nothing exits mid-visit |
| A11 | Call / Text / Email / Navigate on a lead | Opens the phone, SMS, mail and maps apps |
| A12 | Password reset | "Forgot password?" email arrives; the `/reset#…` link opens in the browser and sets the password |
| A13 | Account deletion | More → Edit profile → Delete my account works with a test account |
| A14 | It is the store build | The sign-in screen has no "Try the demo", and More has no "Field testing" / "Simulate no signal" (testing aids are hidden in store builds, `verify:storebuild`) |

### P1 — should pass

| # | Test |
|---|---|
| B1 | Dictation: mic in a note asks for the microphone once, then turns speech into text (needs Google's speech service on the phone) |
| B2 | Tablet: rotate on Today, Map, a visit — no sideways scrolling, buttons reachable |
| B3 | Dark mode: readable in system dark theme |
| B4 | Large font (Settings → Display → Font size max): sign-in and a visit still usable |
| B5 | Badge: QR shows; "Save image" explains it cannot save on Android (known gap) |
| B6 | Slow network (throttled): screens load, errors show a reference instead of a blank page |
| B7 | Sign out, sign in as a different user on the same phone: no data from the first user is visible |

### Permissions and notifications

- The only prompts a rep should ever see: **Location** (while using the app),
  **Microphone** (first dictation). Anything else is a bug.
- The app sends no push notifications (nothing to test; Android 13+ will not ask).

## 5. Feedback and bug triage

**Collecting:**
- Testers send feedback through the Play Store's private feedback on the
  internal-testing listing, or to the support inbox, with: phone model, Android
  version, what they tapped, a screenshot, and the error reference if one showed.
- Bea keeps one sheet: date, tester, device, build (`1.0.0 (2)`), test id, result, link.
- Crashes and ANRs: Console → Quality → Android vitals (Play collects these
  without any SDK in the app).

**Priorities:**

| Level | Meaning | Response |
|---|---|---|
| P0 | Cannot sign in, black screen, data lost, crash on a main path | Stop the rollout; fix and ship a new build (or an OTA update when the fix is JavaScript only) |
| P1 | A main feature broken on some phones | Fix before production |
| P2 | Cosmetic / workaround exists | Next release |

JavaScript-only fixes can ship through EAS Update on the `production` channel
without a new store build; native changes (permissions, SDK, libraries) need a
new AAB with a higher version code.

## 6. Production readiness (exit criteria)

- [ ] Every P0 test passed on the device matrix, on the Play-installed build
- [ ] No open P0/P1 bugs
- [ ] Android vitals: no crash or ANR clusters over a week of use
- [ ] Data safety, content rating, target audience, app access all complete and green in the Console
- [ ] Privacy policy reviewed for Android
- [ ] Company sign-off on the store name, countries and go-live date

## 7. Rollout and rollback

- **Rollout:** promote the tested release from Internal → Production with a
  **staged rollout** — 20% for 2–3 days, then 50%, then 100%, watching Android vitals
  and support mail at each step.
- **Halt:** Console → Production → Halt rollout stops new installs of that release.
- **Rollback:** Play cannot reinstall an older version on phones that already
  updated. Fix forward: either an OTA update for JavaScript fixes (EAS Update,
  `production` channel; republishing the previous update group is the fastest
  rollback) or a new AAB with a higher version code built from the last good
  commit.
