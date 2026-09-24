# Getting the mobile app working: keys, variables, and the order to do it in

Every credential the phone app needs, where each one lives, and the steps in
dependency order. Companion to `MOBILE_AUDIT.md`, which explains *why* each is
needed.

---

## The thing to understand first

There are **two different key problems**, and only one is solved by getting a
key.

**Problem one — keys that are simply missing.** The Worker's geocoding key and
the phone's basemap key. Get them, set them, done.

**Problem two — keys that cannot be made to work in the shell at all.** The
native app is a webview loaded from a `file://` URL. Such a page sends **no
`Referer` header and no `Origin`**. Every browser-side Google and MapTiler key
in this project is restricted by HTTP referrer, because that is the only
protection a key compiled into a public bundle has. A key with a referrer
restriction and a request with no referrer do not match.

You cannot fix that with a different restriction, either: an "iOS app"
restriction validates the bundle identifier sent by the **native** Maps SDK, and
a webview running JavaScript is not that. So for anything in this class the
choice is an **unrestricted key inside a shipped app** — which anyone can lift
out of the bundle and spend — or **moving the call to the Worker**.

Reverse geocoding has already been moved to the Worker for this reason
(`POST /api/geocode/reverse`). Basemap tiles have not, and that is the open
decision in step 4.

---

## 1. Cloudflare Worker — `allstar-api`

Set as **Secrets**, not Text variables: `wrangler deploy` replaces plain-text
vars with whatever is in `wrangler.toml`, so a Text variable added in the
dashboard disappears at the next deploy.

```
npx wrangler secret put NAME        # from api/
```

| Name | Needed for | State |
| --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | Address lookup from the map (new), address geocoding on import, and walking directions | **Required for the map's Add-lead step.** A *server-side* key — no referrer restriction; restrict by IP or leave unrestricted and lock it down by API list |
| `SESSION_PEPPER` | Password hashing | Already set. **Never change it** — it invalidates every password |
| `BACKUP_KEY` | Encrypts the nightly backup | Already set. **Never rotate** — every existing backup becomes permanently unreadable |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Invitation emails | Already set or not; `/api/health` reports `mail` |

`ALLOWED_ORIGINS` lives in `wrangler.toml` as a plain var. **Do not add `null`
to it.** That is what the native bridge exists to avoid — `null` would let every
sandboxed page on the internet call the API. The phone does not need a CORS
entry.

### Google Cloud APIs to enable on `GOOGLE_MAPS_API_KEY`

| API | Used by |
| --- | --- |
| **Geocoding API** | `POST /api/geocode/reverse` (tap a house → address) and `POST /api/import/geocode` |
| **Routes API** | `POST /api/directions` (walking line to a door) |

Geocoding is a **separate switch** from Maps JavaScript and Places. It is the
single easiest thing to miss, because the map itself works without it and the
only symptom is that the Add-lead form stops filling the address in.

---

## 2. Mobile app — EAS environment variables

Set per environment. All three need the same values.

```
cd apps/mobile
npx eas-cli env:create --name NAME --value VALUE \
  --environment development --environment preview --environment production \
  --visibility plaintext
npx eas-cli env:list --environment preview       # check
```

Anything named `EXPO_PUBLIC_*` is **compiled into the app** and readable by
anyone who downloads it. Never put a private secret behind that prefix.

| Name | Needed for | State |
| --- | --- | --- |
| `EXPO_PUBLIC_ORIGIN` | The QR code on every team member badge. Without it the code is built from the webview's local origin — a URL no homeowner's camera can open, and nothing on screen looks wrong | ✅ set in all three |
| ~~`EXPO_PUBLIC_MAPTILER_KEY`~~ | **Retired.** Tiles come from the Worker's `/api/tiles` on the server-side `MAPTILER_API_KEY`; the app reads `/api/health` → `config.tiles` at launch | remove it from the EAS environments |
| `EXPO_PUBLIC_API_URL` | Points the app at a different API | Leave unset. Unset falls back to the deployed Worker, which is what a shipping build wants |
| `EXPO_PUBLIC_GOOGLE_MAPS_KEY` | The Google basemap and Places autocomplete. **Not** Street View any more — that goes through `/api/streetview`, so the phone has it without a key | Set it on `preview` first. It **cannot be restricted** in the shell; a quota cap is what bounds it — see step 5 |
| `EXPO_PUBLIC_GOOGLE_MAP_ID` | Advanced markers, required with the key above | All-or-nothing with it: one without the other is treated as unconfigured |

---

## 3. Web app — Cloudflare Pages build variables

Unchanged by any of this, listed so the three sets can be compared.

| Name | Needed for | State |
| --- | --- | --- |
| ~~`VITE_MAPTILER_KEY`~~ | **Retired.** The web app reads tiles from `/api/tiles` like the phone; nothing loads from MapTiler directly | remove it from Pages and delete the browser key at MapTiler |
| `VITE_GOOGLE_MAPS_KEY` | Google basemap, Places, Street View. Referrer-restricted browser key — restrict to **Maps JavaScript API**, **Places API (New)**, **Street View Static API** and nothing else. A **different key** from the shell's, which cannot be referrer-restricted | Optional, and it now switches the **office console's** maps too, not only the field map |
| `VITE_GOOGLE_MAP_ID` | Required whenever the key above is set | Optional |
| `VITE_PUBLIC_ORIGIN` | Leave empty for web — the running origin is correct | — |
| `VITE_API_URL` | Leave unset in production | — |

---

## The steps

### Step 1 — Deploy the Worker *(Lou or Curtis, 5 minutes)*

`POST /api/geocode/reverse` is written, gated and merged to this branch, and
does not exist in production until the Worker is deployed. Nothing in step 2
matters until it is.

Afterwards, confirm the deploy actually happened — it has silently not happened
before:

```
curl https://allstar-api.josh-af6.workers.dev/api/health | jq '.version, .geocoders'
```

`version` reports the running commit. If it is not the commit you just merged,
the deploy did not run.

### Step 2 — The Google server-side key *(whoever owns Google Cloud, 15 minutes)*

1. Google Cloud console → the project holding the existing browser key.
2. **APIs & Services → Library**: enable **Geocoding API** and **Routes API**.
3. **Credentials → Create credentials → API key.** A *new* key — do not reuse
   the browser one, which is referrer-restricted and would be refused from a
   Worker that sends no referrer.
4. Restrict it: **API restrictions** → Geocoding API + Routes API only.
   **Application restrictions** → None, or by IP. Not by referrer.
5. `cd api && npx wrangler secret put GOOGLE_MAPS_API_KEY`
6. Verify: `curl <api>/api/health | jq .geocoders` should report google.

Cost note: reverse geocoding is billed **per tap** on the map. The client caches
to about a metre and only asks once the Add-lead form is open, so panning and
stray taps cost nothing — but this is a bill that scales with use, and
`/api/geocoders` meters it per company.

### Step 3 — Build and install a `preview` build *(30 minutes, mostly waiting)*

Do this **before** chasing the basemap, because it is what turns 15 "not
verified on a device" rows in the audit matrix into answers.

```
cd apps/mobile
npx eas-cli build --profile preview --platform android    # APK, no Apple account
npx eas-cli build --profile preview --platform ios        # simulator build
```

Android first: `preview` is configured to produce an installable APK and needs
no Apple Developer involvement.

**Use a preview build, not Expo Go.** `expo export` — which is what EAS Update
publishes — mis-locates DOM component assets in a way a real build does not
(`MOBILE_AUDIT.md` §2.4). Expo Go will show you faults that are not there.

Then walk this list on a real phone, because none of it can be checked from a
laptop:

- [ ] Sign in, force-quit the app, reopen — **still signed in?** This is the
      single most important check. It is what the webview swap was for.
- [ ] Add a lead with the app offline, then reconnect — does it upload?
- [ ] Map: does it ask for location, and does the blue dot appear?
- [ ] Tap a house → does the address fill in? (needs step 2 deployed)
- [ ] Take a photo on a lead — does it capture, and does it upload?
- [ ] Navigate on a lead → does the **real Maps app** open with the route?
- [ ] Android: press back inside a lead form — does it go back rather than
      closing the app?

### Step 4 — Basemap imagery: one secret on the Worker *(5 minutes)*

**Decided and built (option 1 from the earlier version of this step): tiles are
proxied through the Worker.** `GET /api/tiles/:layer/:z/:x/:y` holds the key as
a secret, Cloudflare's edge cache answers repeats, and web and phone share one
path. Nothing in either bundle carries a key any more.

1. Create the key in the **company-owned** MapTiler account (`LAUNCH.md` item 4),
   with **no HTTP-origin restriction** — a Worker sends no `Origin`, so an
   origin-locked key would refuse every request. It is a secret, not a browser
   key, which is what makes that safe.
2. `cd api && npx wrangler secret put MAPTILER_API_KEY`
3. `curl <api>/api/health | jq .config.tiles` → `true`. Both apps pick it up on
   their next launch; no Pages rebuild, no `eas update`.
4. Remove `VITE_MAPTILER_KEY` from Cloudflare Pages and `EXPO_PUBLIC_MAPTILER_KEY`
   from the three EAS environments, then delete the old browser key at MapTiler.

What the route exposes, and why that is acceptable, is written at the top of
`api/src/tiles.ts`: the layer and zoom are whitelisted to what the app itself
asks for, the edge cache absorbs repeats, and MapTiler's free tier is a hard cap
with no overage billing — so the worst case is a blank map until the month rolls
over, an outage rather than an invoice. `smoke:tiles` drives all of it.

### Step 5 — The Google basemap on the phone *(decided; the risk is unchanged)*

**This step used to recommend against it. The decision has been reversed by the
business — MapTiler is to be removed — so what follows is what the reversal
costs and how it is bounded, not an argument.**

The technical objection stands exactly as it did, and nothing in the app fixes
it: `EXPO_PUBLIC_GOOGLE_MAPS_KEY` **cannot be secured in the shell.** A referrer
restriction does not match a request with no referrer, and a bundle-ID
restriction applies to Google's native SDKs, not to a `fetch()` from a webview.
A key in the shell is therefore unrestricted by construction, sitting in a
downloadable APK, spendable by anyone who unzips it.

What changes is the consequence, and it is worse than the MapTiler version of
this mistake (LAUNCH.md item 4): MapTiler's free tier is a hard cap, so abuse
produced a blank map. Google Maps Platform is metered with no ceiling by
default, so abuse produces an invoice.

So the mitigation is not optional and it is not in this repo — it is in the
Cloud console:

1. **Two keys, not one.** The web build gets an HTTP-referrer-restricted key
   (`allstar.letlois.com`, `allstar-app.pages.dev`, localhost). Only the shell
   build gets the unrestricted one.
2. **API restrictions on both**, to Maps JavaScript API, Places API (New) and
   Street View Static API, and nothing else.
3. **A per-API daily quota cap** on the unrestricted key. This is what replaces
   the hard stop MapTiler gave for free: it converts a leaked key from an
   invoice into an outage.
4. **A billing budget alert** on the project.

Nothing else moves. The server-side `GOOGLE_MAPS_API_KEY` stays a Worker secret
and stays separate — reverse geocoding, routes and Street View continue to run
there, and the app continues to deal in coordinates and results rather than in
keys. `/api/streetview` is the worked example: the app sends a point, the Worker
reads the company's encrypted key, checks the free metadata endpoint, and
returns bytes. See `api/src/streetview.ts`.

The *right* long-term answer is still the one this step gave: the Google basemap
belongs with the first **native** map screen (`react-native-maps` and the real
iOS/Android Maps SDK, which bundle-ID restriction does protect), where the key
can actually be restricted. That is on the migration plan in
`MIGRATION_PROGRESS.md` and is unaffected by any of the above.

### Step 6 — Unblock end-to-end testing from a Claude session *(optional, 2 minutes)*

This environment's network policy answers 403 to every CONNECT for
`allstar.letlois.com` and the Worker, so no session here can run a real
manager→rep→export test. Adding those two hosts to the environment's network
policy would let a session drive the live API. Otherwise those tests happen on a
device, by hand.

### Step 7 — Store records *(when the above is green)*

Needed before submission, and not before:

- **App Store Connect** app record → gives you the `ascAppId` that
  `eas.json`'s `submit.production.ios` is missing.
- **Play Console** app record, app signing, Data Safety declarations.
- A **Privacy Policy URL** and in-app **account deletion**, which both stores
  require.
- Link the GitHub repo to the Expo project with **base directory
  `apps/mobile`** — possible once a first `eas build` has succeeded.
