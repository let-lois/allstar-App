# Google Maps on preview — configuration and device tests

Everything here is **manual and preview-only**. Nothing in it has been done for
you, nothing touches production, and MapTiler stays exactly where it is until
the checklist at the end comes back clean on all three surfaces.

The code change this accompanies is switched on by two environment variables and
switched off by removing them. With them unset, every map and every byte is what
it was before.

**Two things to know before you start, both measured on this branch:**

1. **A real iPhone receives `preview` updates only through the
   `testflight-preview` build** (§5b, TestFlight build 4 and later). The plain
   `preview` profile is iOS-simulator-only (§5.3), and production TestFlight
   builds 2 and 3 listen to the `production` channel.
2. **Metro's transform cache will silently bake stale values into the bundle.**
   See §3. This is the single most likely way to spend an afternoon on "I set
   the variables and nothing happened".

---

## 1. Google Cloud — click by click

Everything below is at <https://console.cloud.google.com>. Pick the right
project in the project dropdown at the top of every page first — the one that
already holds the Worker's geocoding key.

### 1.1 APIs to enable

Left-hand menu → **APIs & Services** → **Enabled APIs & services** → the
**+ ENABLE APIS AND SERVICES** button at the top → search each by name → click
it → **ENABLE**.

| API | Why | Action |
| --- | --- | --- |
| **Maps JavaScript API** | The basemap itself | **Enable** — this is the new one |
| **Places API (New)** | Address autocomplete in the map's search field | Confirm enabled |
| **Street View Static API** | The photo on a lead, via `/api/streetview` | Confirm enabled |
| **Geocoding API** | Server-side address → coordinate | Confirm enabled |
| **Routes API** | Server-side walking/driving route | Confirm enabled |

The Maps JavaScript *libraries* — `marker`, `places`, `geometry` — are not
separate products and need nothing enabled. They are named in the bootstrap URL
by `src/lib/gmaps.ts`.

### 1.2 APIs that must NOT be enabled

| API | Why not |
| --- | --- |
| **Map Tiles API** | Its terms forbid the permanent tile storage the offline map does. Nothing in this app requests it, and enabling it only widens what a leaked key can spend |
| **Maps SDK for Android / iOS** | Those are for Google's native SDKs. This app's map runs in a webview and cannot use them; enabling them adds spend surface for nothing |
| **Places API** (the *old* one) | The app uses Places **(New)**. Leave the legacy one off |

### 1.3 The web browser key

**APIs & Services** → **Credentials** → **+ CREATE CREDENTIALS** → **API key**.
A dialog shows the new key. Click **Edit API key** (or find it in the list and
click its name).

1. **Name**: `allstar-web-browser` — so the next person knows which is which.
2. **Application restrictions** → select **Websites**.
3. Under *Website restrictions*, click **ADD** once per entry:
   ```
   https://allstar.letlois.com/*
   https://allstar-app.pages.dev/*
   http://localhost:5173/*
   http://127.0.0.1:4173/*
   ```
   The last two are for local development and the local preview in §4. Google
   matches these exactly, so the `/*` suffix matters.
4. **API restrictions** → select **Restrict key** → in the dropdown tick exactly:
   - Maps JavaScript API
   - Places API (New)
   - Street View Static API

   Nothing else. Not Geocoding, not Routes — those are server-side and use a
   different key.
5. **SAVE**. Restriction changes can take up to five minutes to take effect.

### 1.4 The mobile / webview shell key

Same path: **Credentials** → **+ CREATE CREDENTIALS** → **API key** → **Edit**.

1. **Name**: `allstar-shell-unrestricted-quota-capped` — name it after what it
   is, so nobody re-uses it by accident.
2. **Application restrictions** → **None**. See §1.6 for why this is forced
   rather than lazy.
3. **API restrictions** → **Restrict key** → the same three APIs as above.
4. **SAVE**.
5. Go straight to §1.8 and set the quota caps. This key is spendable by anyone
   who unzips the APK, and the cap is the only thing bounding it.

**This must be a different key from §1.3.** One key doing both jobs would mean
dropping the website restriction from the web build too, which throws away
protection you can actually have.

### 1.5 The existing Worker key — unchanged

**Do not touch it.** `GOOGLE_MAPS_API_KEY` is a Cloudflare Worker secret used
server-side for Geocoding, Routes and Street View Static. It is not in any
bundle, it is not referrer-restricted (a Worker sends no `Referer`), and none of
the work here reads or changes it.

To confirm it is still configured:

```
curl -s https://allstar-api.josh-af6.workers.dev/api/health | jq '.config.googleGeocoding, .config.tiles'
```

`true, true` means Google geocoding and MapTiler imagery are both still on.

### 1.6 Why the shell key cannot use a referrer restriction

Not a preference — a property of the platform:

- The native app's page is served from `file://`. A `file://` page sends **no
  `Referer` header at all**, so a website restriction has nothing to match and
  Google refuses the request.
- Google's **Android apps** and **iOS apps** key restrictions authenticate a
  request coming from *Google's own native SDKs*, by app signature or bundle ID.
  A `fetch()` from inside a webview has no way to present either.

So an in-app key is unrestricted or it is rejected. There is no third setting.
This is the same mechanism that put a `?` wildcard on the old MapTiler key
(LAUNCH.md item 4) — except the consequence is worse: MapTiler's free tier is a
hard cap, so abuse produced a blank map, while Google is metered with no ceiling
and abuse produces an invoice. §1.8 is what puts the ceiling back.

### 1.7 The Map ID

Left-hand menu → **Google Maps Platform** → **Map management** →
**CREATE MAP ID**.

1. **Map ID name**: `allstar-field-map`
2. **Map type**: **JavaScript**
3. **Raster or vector**: **Vector**
4. **SAVE**. Copy the ID it gives you (a short alphanumeric string).
5. **Do not attach a Map style.** Leave the *Map style* field empty.

The last point is invisible afterwards and worth the extra second: the app asks
for `colorScheme: 'DARK'` so Google's basemap matches the rest of the app, and a
Map Style attached to the Map ID silently overrides that while still reporting
`VECTOR`. If the map comes up light inside the dark app, that is where to look —
`packages/core/src/basemap.ts` logs a console warning naming both causes.

**Use the same Map ID for web and shell.** It carries no quota and nothing
spendable.

### 1.8 Quota caps — not optional for the shell key

**APIs & Services** → **Enabled APIs & services** → click the API → the
**QUOTAS & SYSTEM LIMITS** tab → find the *Requests per day* row → tick it →
**EDIT QUOTAS** → enter a value → **SUBMIT REQUEST**.

Do this for each of the three APIs.

Sizing it: count reps × how many times a day each opens the map, then roughly
double it. For a 20-rep crew opening the map ~100 times a day that is ~2,000
loads/day, so a 5,000/day cap leaves headroom and still stops a leaked key cold.

| API | Suggested starting cap | What it counts |
| --- | --- | --- |
| Maps JavaScript API | 5,000 / day | One per map screen mount |
| Street View Static API | 5,000 / day | One per lead whose photo loads — uncovered leads cost nothing, because the free metadata call answers first |
| Places API (New) | 2,000 / day | One per autocomplete session, not per keystroke |

Check current pricing and free-tier terms in the console before settling on a
number — Google changes both, and this file will not.

### 1.9 Billing budget alert

Left-hand menu → **Billing** → **Budgets & alerts** → **CREATE BUDGET**.

1. **Name**: `All-Star Maps`
2. **Scope** → Projects → select this project only.
3. **Amount** → *Specified amount* → a monthly figure somebody will act on.
4. **Actions** → leave the 50% / 90% / 100% thresholds, tick **Email alerts to
   billing admins and users**.
5. **FINISH**.

The budget alert emails; it does **not** stop spend. The quota caps in §1.8 are
what actually stop it. Set both.

---

## 2. Preview environment variables

**Nothing below goes anywhere near production.**

### 2.1 Cloudflare Pages — Preview scope only

<https://dash.cloudflare.com> → **Workers & Pages** → the All-Star Pages project
→ **Settings** → **Environment variables** → the **Preview** section (not
Production) → **Add variable**:

| Name | Value |
| --- | --- |
| `VITE_GOOGLE_MAPS_KEY` | the **web** key from §1.3 |
| `VITE_GOOGLE_MAP_ID` | the Map ID from §1.7 |

Then redeploy the preview branch. These are **build-time** values — Vite inlines
them into the bundle, so setting them without a rebuild changes nothing.

> See §4 first. Hashed Pages preview URLs cannot sign in, so the local workflow
> is the one to use for web testing.

### 2.2 EAS — preview environment only

Easiest without any CLI-flag risk: <https://expo.dev> → the `all-star-app`
project → **Environment variables** → **Create variable**, once per row:

| Name | Value | Environment | Visibility |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_GOOGLE_MAPS_KEY` | the **shell** key from §1.4 | **Preview** only | Plain text |
| `EXPO_PUBLIC_GOOGLE_MAP_ID` | the Map ID from §1.7 | **Preview** only | Plain text |

Leave Production unticked on both.

Plain text, not Secret, and the honesty is the point: these values are compiled
into the bundle and readable by anyone who unzips the APK. Marking them secret
would misdescribe what ships, and a "secret" EAS variable is not exposed to the
bundler anyway. The quota cap in §1.8 is the actual control.

The CLI equivalent, if you prefer it — confirm the flags against
`eas env:create --help` for your version, since `eas-cli` is not installed in
this repo and the spellings could not be run and checked here:

```
cd apps/mobile
eas env:create --environment preview --name EXPO_PUBLIC_GOOGLE_MAPS_KEY --value '<shell key>' --visibility plaintext
eas env:create --environment preview --name EXPO_PUBLIC_GOOGLE_MAP_ID   --value '<map id>'    --visibility plaintext
eas env:list preview     # both present
eas env:list production  # neither present
```

### 2.3 `EXPO_PUBLIC_MAPTILER_KEY` — leave it or delete it, it does nothing

Verified: **no source file reads `EXPO_PUBLIC_MAPTILER_KEY` or
`VITE_MAPTILER_KEY`, and `vite.config.ts` does not pass either.** They have been
dead since the tile proxy moved to the Worker.

- Keeping them during preview costs nothing and changes nothing.
- Deleting them costs nothing and changes nothing.
- **Neither affects MapTiler imagery.** That comes from the Worker secret
  `MAPTILER_API_KEY`, which must stay — `/api/health` reporting `"tiles": true`
  is what keeps the offline map and the `FieldMap` fallback drawing imagery.

Recommendation: leave them alone for now. Deleting a dead variable during a test
window only adds a variable to the experiment.

---

## 3. Metro cache safety — the OTA publish sequence

Measured on this branch, not inferred. Exporting with both variables set:

- **Warm cache**: `src/lib/gmaps.ts` came out of the bundle with **both** Google
  values compiled to `undefined`, while `src/components/property/StreetView.tsx`
  — edited that day, so a cache miss — got the real literal.
- **Cleared cache**: both carried correctly.

`EXPO_PUBLIC_*` values are not part of Metro's transform cache key, so a module
you have not touched keeps whatever was inlined the last time it was
transformed. `gmapsConfigured()` then returns false, the app quietly keeps its
own renderer, and nothing errors — identical to never having set the variables.

**So clear the cache by deleting it, which no CLI flag spelling can get wrong:**

```
cd apps/mobile
rm -rf "${TMPDIR:-/tmp}"/metro-cache "${TMPDIR:-/tmp}"/metro-file-map-* .expo
```

### 3.1 Verify the bundle before publishing

Export locally first and check what came out. **Nothing below prints a key** —
`grep -c` reports a count and never the matched text.

```
cd apps/mobile
rm -rf "${TMPDIR:-/tmp}"/metro-cache "${TMPDIR:-/tmp}"/metro-file-map-* .expo

export EXPO_PUBLIC_GOOGLE_MAPS_KEY='<shell key>'
export EXPO_PUBLIC_GOOGLE_MAP_ID='<map id>'

npx expo export --clear --platform android --output-dir /tmp/gmaps-check

BUNDLE=$(ls /tmp/gmaps-check/www.bundle/*.js)
echo "map id occurrences: $(grep -c -F -- "$EXPO_PUBLIC_GOOGLE_MAP_ID" "$BUNDLE")"
echo "key occurrences:    $(grep -c -F -- "$EXPO_PUBLIC_GOOGLE_MAPS_KEY" "$BUNDLE")"
```

**The map-id count is the one that decides it, and it must be ≥ 1.**

Why that one line is sufficient: `EXPO_PUBLIC_GOOGLE_MAP_ID` is read in exactly
one place in the entire codebase — `src/lib/gmaps.ts:27`. So if the string is in
the bundle at all, `MAP_ID` is non-empty in that module; and `KEY` is the
constant on the line above it, transformed by the same cache entry, so it is
non-empty too. `gmapsConfigured()` is `!!KEY && !!MAP_ID`, so it evaluates
**true**.

A count of `0` means the bundle has no Map ID, `gmapsConfigured()` is false, and
the Google map will not appear on the device — whatever the EAS dashboard says
the variables are. Delete the caches and export again.

Clean up when you are done, so no key sits in a temp directory:

```
rm -rf /tmp/gmaps-check
unset EXPO_PUBLIC_GOOGLE_MAPS_KEY EXPO_PUBLIC_GOOGLE_MAP_ID
```

---

## 4. Local web preview — the workflow that actually works

Hashed Cloudflare Pages preview URLs **cannot sign in**: `ALLOWED_ORIGINS` in
`api/wrangler.toml` is an exact-match list and the per-deployment
`*.allstar-app.pages.dev` hostnames are not on it. That is LAUNCH.md item 16 and
it predates this work. Changing it is a production Worker change and is out of
scope here.

`http://127.0.0.1:4173` **is** on the list, so build and serve locally:

```
cd /path/to/allstar-App

VITE_GOOGLE_MAPS_KEY='<web key>' \
VITE_GOOGLE_MAP_ID='<map id>' \
npm run build

npx vite preview --port 4173 --host 127.0.0.1
```

Then open **http://127.0.0.1:4173** — not `localhost:4173`, which is a different
origin string and is on the list only for the dev server on port 5173.

### 4.1 Confirming the Google renderer is actually active

Two checks, neither needing a console:

1. **Look at the bottom-left of the map.** `FieldMap` prints its tile
   attribution there — `© MapTiler © OpenStreetMap contributors`. If you can see
   that, you are on the fallback renderer. Google draws its own attribution and
   logo along the bottom instead.
2. **Sign in as an admin → `/admin/settings` → "Google Maps on this build".**
   A built-in panel that reports, in order: whether a browser key is compiled
   in, whether a Map ID is compiled in, whether Maps JavaScript accepts the key,
   whether Places is enabled, and whether Geocoding is enabled. It also has a
   button that makes one billed request against a public landmark, so you can
   prove the key works without driving anywhere.

If you want a one-liner in the browser console:

```js
!!document.querySelector('.gm-style')                        // true  → Google
document.querySelectorAll('[data-marker="pin"]').length > 0  // true  → FieldMap
```

### 4.2 Testing the Admin Console locally

The console is desktop software and is **not in the phone bundle at all** — see
§7. On the web it works at any width. Sign in as each role using the demo
accounts:

| Role | Demo name | Expect |
| --- | --- | --- |
| super admin | Curtis Lane | everything, including Clients |
| admin | Nadia Petrov | Settings yes, Clients refused |
| manager | Ray Okafor | no Settings, no Clients, both refused by URL |
| field rep | Dana Whitfield | no console link at all; `/admin` refused |

---

## 5. Mobile preview OTA

### 5.1 The publish

```
cd apps/mobile

# 1. clear the cache (§3) — this is the step that matters
rm -rf "${TMPDIR:-/tmp}"/metro-cache "${TMPDIR:-/tmp}"/metro-file-map-* .expo

# 2. confirm the channel points where you think it does
eas channel:view preview

# 3. publish to the preview branch only
eas update --branch preview --message "Google basemap + Street View fixes (preview)"
```

`eas update` bundles **on the machine you run it from**, which is exactly why
step 1 matters. If your `eas-cli` has a cache flag
(`eas update --help | grep -i cache`), pass it as well — belt and braces.

Never `--branch production`, never `--channel production`.

### 5.2 Confirming the OTA reached the device

**Relaunch twice.** `expo-updates` defaults to downloading on launch and
applying on the *next* launch, so the first reopen fetches it and the second
shows it. Force-close the app fully between the two.

Then, in order of how much they prove:

1. **The Street View sentence.** Open the map, tap a pin, look at the photo
   frame on the sheet. If it can say *"No Street View imagery is available near
   this property"* or *"Property imagery is temporarily unavailable"*, the new
   bundle is running. The old bundle can only say *"No photo of this house
   yet"*, and that sentence no longer exists anywhere in the code. This check
   works **even if the Google configuration is wrong**, which makes it the one
   to do first: it separates "the OTA did not arrive" from "the OTA arrived and
   the key is wrong".
2. **The map itself.** Google imagery instead of the drawn grid, and no
   `© MapTiler` attribution at the bottom-left.
3. **From your machine**: `eas update:list --branch preview` shows the update
   group, its runtime version and its platforms. Confirm the runtime version
   matches the installed build's — both should be `exposdk:57.0.0`, since
   `app.json` sets `runtimeVersion.policy: "sdkVersion"`.

### 5.3 A real iPhone cannot take a `preview` update today

This is a genuine blocker, not a caveat. From `apps/mobile/eas.json`:

- The **`preview`** profile sets `ios.simulator: true` — it builds for the iOS
  **Simulator only** and cannot be installed on a phone.
- The **`preview-device`** profile exists for exactly this (`simulator: false`,
  inheriting `channel: preview` and `distribution: internal`), but no build has
  been made from it. It needs an ad-hoc provisioning profile with each test
  device's UDID registered, and this project's history is that
  `eas credentials --platform ios` has to be run interactively.
- The existing **TestFlight build listens to the `production` channel**, so a
  `preview` update will not reach it — and publishing to `production` is out of
  scope.

So iPhone testing needs one of:

- **(a)** `eas build --profile preview-device --platform ios`, after registering
  the test devices (`eas device:create`) and completing credentials
  interactively. Then install via the internal-distribution link and the
  `preview` OTA reaches it. **This is an iOS-only requirement forced by the
  simulator flag — not by anything in this change, and Android needs no new
  build.**
- **(b)** The iOS **Simulator** on a Mac, using the existing `preview` profile.
  Good enough for everything except the two things a simulator cannot tell you:
  real GPS and real WebKit performance on device hardware.

Android has no equivalent problem: the `preview` profile builds an internal APK
on `channel: preview`, so an already-installed preview APK takes the update.

---

## 5b. iPhone through TestFlight — the `testflight-preview` profile

The ad hoc path in §5.3 needs device registration and interactive Apple
credentials. There is a second way onto a real iPhone that needs neither and
still never touches production: **a store build that listens to the `preview`
channel**, uploaded to App Store Connect and installed through TestFlight's
*internal* testing. That is what the `testflight-preview` profile in
`apps/mobile/eas.json` is.

```json
"testflight-preview": {
  "distribution": "store",
  "channel": "preview",
  "environment": "preview",
  "autoIncrement": true,
  "ios": { "image": "latest" }
}
```

Why each line is what keeps it safe:

| Field | Effect |
| --- | --- |
| `distribution: store` | Produces an App Store-signed `.ipa` that App Store Connect accepts. Distribution is about *signing and where the file can go*; it says nothing about which updates the app fetches |
| `channel: preview` | Baked into the binary's `Expo.plist` as `expo-channel-name`. Every update request this build ever makes asks for `preview`; the server only answers with updates on the branch mapped to that channel. A production OTA is unreachable by construction |
| `environment: preview` | Written, not inferred: EAS Build compiles the **preview** environment's `EXPO_PUBLIC_*` values into the embedded bundle. The production key never enters it |
| `autoIncrement: true` | Takes the next build number from EAS's remote counter, shared per bundle identifier — so it cannot collide with production build 3 |
| no `extends` | A later change to `production` cannot leak in |

`verify:easprofiles` pins all of this and asserts `production` is unchanged as an
exact object, so a "tidy both" edit fails before it builds.

**Uploading to TestFlight is not a release.** `eas submit` uploads the build to
App Store Connect, where it appears under TestFlight. An App Store release
happens only when somebody creates a version in App Store Connect and clicks
*Submit for Review*. **Internal** TestFlight testing (App Store Connect team
members, up to 100) needs no Apple review at all; *external* testing does, and
is not part of this.

**Same bundle identifier.** TestFlight shows all builds for the one app record;
you pick which to install. iOS keeps one app per bundle identifier per phone, so
installing the preview build **replaces** production build 3 on that phone.
Build 3 itself is untouched in App Store Connect and can be reinstalled from
TestFlight at any time. Nothing about the production channel, its OTAs or its
variables changes.

### Build

```
cd apps/mobile
eas build --platform ios --profile testflight-preview --clear-cache \
  --message "Google Maps TestFlight preview"
```

Interactive is fine here — it reuses the existing App Store distribution
certificate and provisioning profile that production builds 2 and 3 already
used, so there is nothing new to create with Apple.

Before building, confirm the preview environment holds the two Google variables
and production does not (names only are printed by default):

```
eas env:list preview
eas env:list production
```

### Upload — this build, by ID, not "latest"

```
eas build:list --platform ios --build-profile testflight-preview --limit 1   # copy the build ID
eas submit --platform ios --profile testflight-preview --id <BUILD_ID> \
  --what-to-test "PREVIEW channel — Google Maps test build. Not for release."
```

`--id` rather than `--latest`: "latest" is whichever iOS build finished most
recently, and if a production build were ever queued alongside, that is the one
you would upload. The `--what-to-test` text appears in the TestFlight app next
to the build, which is the first identity check a tester sees.

### Internal testing, then install

1. App Store Connect → the app → **TestFlight** tab. The build appears under
   **iOS builds** with status *Processing*; wait for *Ready to Test* (usually
   minutes, occasionally an hour).
2. If asked about export compliance, the answer is already in `app.json`
   (`ITSAppUsesNonExemptEncryption: false`), so no prompt should appear.
3. **Internal Testing** in the left column → an existing group, or **+** to
   create one (e.g. *Google Maps preview*) → add yourself → **Builds** → **+**
   → select the new build number.
4. On the iPhone: open **TestFlight** → All-Star → the new build is listed with
   its number and the *What to Test* text → **Install** (it replaces build 3).

### Prove which build you are holding

- **On screen:** a small strip in the top-right corner reading
  `BUILD: PREVIEW (not production) · CHANNEL: preview · RUNTIME: exposdk:57.0.0
  · UPDATE: <8 chars or none> · EMBEDDED: yes/no`. It is rendered only when the
  channel is one this project recognises as internal (the same rule that opens
  the Web Inspector); **production build 3 shows nothing**. Its absence is
  itself the answer.
- **TestFlight app:** build number 4+ (production is 3) and the *What to Test*
  text.
- **From a Mac:** `eas build:view <BUILD_ID>` → distribution `STORE`, channel
  `preview`, runtime `exposdk:57.0.0`, profile `testflight-preview`;
  `eas submit:status --platform ios` → the TestFlight builds Apple knows about.
- **Safari Web Inspector** attaches (Develop → *iPhone* → All-Star) — it cannot
  on build 3.

### Preview OTA to the TestFlight build

Same command as §5.1 — `--branch preview --environment preview --clear-cache`.
The build's channel is `preview`, runtime `exposdk:57.0.0`, platform iOS: a
preview update matches all three and is downloaded on launch, applied on the
next. The strip's `UPDATE:` changes from `none`/`EMBEDDED: yes` to the first
eight characters of the group's update ID and `EMBEDDED: no`; match it against
`eas update:list --branch preview`. `eas update:insights <GROUP_ID>` shows the
launch from the server side.

## 6. Device test order

Run them in this order. Each stage catches things that would waste your time in
the next.

### Stage 1 — Desktop / local web (§4)

Fastest feedback, and the console only exists here.

**Map**
- [ ] Google renderer active (no `© MapTiler` attribution; `/admin/settings` panel all green)
- [ ] Standard map draws with labels
- [ ] SAT button switches to hybrid/satellite
- [ ] Map type persists across a navigation away and back
- [ ] Map type persists across a full page reload
- [ ] Pins render in status colours
- [ ] Clusters group when zoomed out; a cluster tap zooms to it
- [ ] Tapping a pin opens the sheet; tapping open map dismisses it
- [ ] Add a lead: the picker places a pin where you click
- [ ] With the form open, clicking an existing lead's dot still places the *new* pin
- [ ] Current location works
- [ ] Route line draws on the navigate screen
- [ ] Flight line: open a lead on another continent — dashed line with a plane, whole arc framed

**Drawing (console)**
- [ ] `/admin/territories` → New territory → each tap places a white vertex handle
- [ ] Outline dashed under three points, filled at three
- [ ] A tap **inside** the filled shape adds a vertex (does not get swallowed)
- [ ] A tap **on a lead pin** while drawing adds a vertex (does not open the lead)
- [ ] A tap **on a cluster bubble** while drawing adds a vertex (does not zoom)
- [ ] Undo point / Start over clear the shape from the map
- [ ] "Create with N leads" counts what you enclosed
- [ ] `/admin/lists` → same, plus a saved list's boundary shows read-only
- [ ] `/admin/leads` → lasso selects the same leads it used to

**Street View**
- [ ] A normal suburban lead shows a photo
- [ ] The photo is **of the house**, not of the road ahead
- [ ] A lead set well back from the road still gets a photo
- [ ] A genuinely uncovered rural lead reads *"No Street View imagery is available near this property"*
- [ ] Nothing anywhere reads *"No photo of this house yet"*
- [ ] **Failure simulation** (safe and reversible): in the Cloud console disable
      **Street View Static API**, wait a minute, reload a lead → the frame must
      read *"Property imagery is temporarily unavailable"* and must **not** claim
      the street is unphotographed. Re-enable it and confirm the photo returns.
      Do this against the preview key's project only.

**Roles** — the table in §4.2.

**Fallback**
- [ ] Temporarily blank `VITE_GOOGLE_MAPS_KEY`, rebuild, reload → `FieldMap`
      renders with MapTiler imagery and the `© MapTiler` attribution returns
- [ ] Offline maps download still works and the saved area draws with no network
- [ ] Restore the key and rebuild

### Stage 2 — Android preview APK

Everything in Stage 1 that is not console-only, plus the Android-specific set.
The console is **not in this bundle** and must not appear (§7).

- [ ] **Blank-map check.** The map is not a grey rectangle with the filter chips
      floating on it. This is the highest-risk unknown in the whole change:
      Google's vector renderer compiles WebAssembly and runs label layout in a
      worker created from a `blob:` URL, and Android System WebView has
      historically blocked blob-URL workers under a `file://` origin
- [ ] Labels and roads paint correctly
- [ ] If the map does fail, it falls back to `FieldMap` with MapTiler imagery
      within ~10 seconds rather than staying grey
- [ ] No crash and no reset to Home on any map interaction
- [ ] Pinch-zoom does not drop a new-lead pin
- [ ] Offline map download still works

**If the map is blank on Android** — the fix is not a code change:

1. Cloud console → **Google Maps Platform** → **Map management** → your Map ID.
2. Change **Raster or vector** from Vector to **Raster**. Save.
3. Force-close and reopen the app twice.

A raster map needs no WebAssembly and no blob worker. It is slower and less
pretty, the dark colour scheme will not apply, and it costs nothing else. If
that fixes it, you have confirmed the cause; decide then whether to keep raster
or stay on `FieldMap` for Android.

### Stage 3 — iPhone

Only reachable via §5.3 option (a) or (b). Same list as Stage 2 minus the
Android-specific section, plus:

- [ ] Safe-area insets correct — map runs under the notch, dock clear of the
      home indicator
- [ ] Page zoom does not happen when pinching the map

---

## 7. The Admin Console on a phone

**Superseded by PR #163 (`835de0a`).** The console is in the phone bundle now:
`apps/mobile/metro.config.js` swaps `src/adminRoutes.tsx` for
`apps/mobile/src/admin-routes-native.tsx`, which imports the same screens
statically through the shared `src/admin/routeTree.tsx`. More → **Admin
console** is shown to every non-rep role on every surface; `AdminLayout` still
refuses a field rep, and the Worker refuses them again on every call.

It reaches a phone only with a bundle built from `835de0a` or later — today the
`preview` update on TestFlight build 4. Production builds 2 and 3 were built
before it and have no production update, so they still have no console.

---

## 8. MapTiler stays

Nothing in this document removes MapTiler, and nothing should until every box
above is ticked on web, iPhone and Android.

The `FieldMap` renderer is what runs when Google is unavailable — no signal, a
device whose WebGL is blocked, a rejected key — and it draws MapTiler imagery
through `/api/tiles` and serves the offline download. Removing MapTiler before
Google is proven would mean the fallback loses its imagery at exactly the moment
it is needed.

When the time comes, the list is: the `MAPTILER_API_KEY` Worker secret,
`api/src/tiles.ts` and its route, the `tiles` flag in `/api/health`,
`MAPTILER_API_KEY`/`MAPTILER_BASE_URL` in `api/src/types.ts` and
`api/wrangler.toml`, `src/lib/tiles.ts`, the offline-map subsystem, four gates
and the docs. Not before.
