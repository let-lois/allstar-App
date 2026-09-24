# Google Maps on preview — what to configure, and what to test

Everything in this document is **manual and preview-only**. Nothing here has
been done for you, nothing here touches production, and MapTiler stays exactly
where it is until the checklist at the end comes back clean on all three
surfaces.

The code change this accompanies did four things: fixed Street View's search and
its error reporting, gave the Google renderer territory drawing, put every map
screen behind one renderer-selection component, and left the self-rendered map
in place as the fallback. None of it is switched on by code — it is switched on
by the two environment variables in step 2, and switched off by removing them.

---

## 1. Google Cloud — the part that must happen first

### 1.1 APIs to enable

| API | Why | State to confirm |
| --- | --- | --- |
| **Maps JavaScript API** | The basemap itself. This is the new one | **Enable** |
| **Places API (New)** | Address autocomplete in the map's search field | Confirm enabled |
| **Street View Static API** | `/api/streetview` — the photo on a lead | Confirm enabled |
| **Geocoding API** | Server-side, already live | Confirm enabled |
| **Routes API** | Server-side walking/driving routes | Confirm enabled |
| ~~Map Tiles API~~ | — | **Do not enable.** Its terms forbid the permanent tile storage the offline map does, and nothing in this app asks for it |

The Maps JavaScript libraries — `marker`, `places`, `geometry` — are not separate
products and need nothing enabled. They are requested in the bootstrap URL by
`src/lib/gmaps.ts`.

### 1.2 Credentials — three keys, and they are not interchangeable

| Key | Where it lives | Restriction | Notes |
| --- | --- | --- | --- |
| **Web browser key** | Cloudflare Pages build var `VITE_GOOGLE_MAPS_KEY` | **HTTP referrers**: `https://allstar.letlois.com/*`, `https://allstar-app.pages.dev/*`, `http://localhost:5173/*`, `http://127.0.0.1:4173/*` | Compiled into the web bundle and therefore public. The referrer list is what protects it |
| **Shell key** | EAS env var `EXPO_PUBLIC_GOOGLE_MAPS_KEY` | **None possible** — see below | A *separate* key, so the web key stays locked |
| **Server key** | Worker secret `GOOGLE_MAPS_API_KEY` | IP or none; never referrer | **Unchanged. Do not reuse it for either of the above.** It is read server-side for geocoding, routes and Street View |

**The shell key cannot be restricted, and this is the one thing to understand
before agreeing to any of it.** The native app's page is `file://`. It sends no
`Referer`, so a referrer restriction can never match it; and Google's Android
and iOS key restrictions authenticate their own native SDKs by app signature,
which a `fetch()` from inside a webview cannot present. An in-app key is
unrestricted or rejected. There is no third setting.

MapTiler had the same problem and the blast radius was a blank map, because its
free tier is a hard cap. Google is metered with no ceiling. So:

### 1.3 Restrictions and caps — not optional

On **both** browser keys, set **API restrictions** to exactly:

- Maps JavaScript API
- Places API (New)
- Street View Static API

On the **shell key**, additionally:

- **A per-API daily quota cap** (Cloud console → APIs & Services → the API →
  Quotas → *Requests per day*). This is what replaces the hard stop MapTiler
  gave for free. Pick a number a few times your expected daily map loads. It
  turns a leaked key from an invoice into an outage, which is the right way
  round.
- **A billing budget alert** on the project, at a figure somebody will act on.

Do both before the key exists anywhere outside the console.

### 1.4 The Map ID

Cloud console → Google Maps Platform → **Map Management** → Create Map ID.

- **Map type: JavaScript**
- **Raster or vector: Vector**
- **No Map Style attached.**

The last one matters and is invisible afterwards. The app asks for
`colorScheme: 'DARK'` so Google's basemap matches the rest of the app; a Map
Style attached to the Map ID silently overrides that and still reports
`VECTOR`, so the map comes up light inside a near-black app with nothing
explaining why. `packages/core/src/basemap.ts` logs a console warning naming
both causes — check the browser console if the map looks wrong.

Use the **same Map ID** for web and shell. It carries no quota and nothing
spendable.

---

## 2. Preview activation — the exact variables

**Do not run any of this against production.**

### 2.1 Web

Cloudflare Pages → the project → Settings → Environment variables →
**Preview** (not Production):

```
VITE_GOOGLE_MAPS_KEY = <the referrer-restricted web key>
VITE_GOOGLE_MAP_ID   = <the Map ID>
```

Then redeploy the preview branch. These are **build-time** values — Vite inlines
them, so setting them without a rebuild changes nothing.

> **Known blocker for Pages preview URLs.** `ALLOWED_ORIGINS` in
> `api/wrangler.toml` is an exact-match list, and the hashed
> `*.allstar-app.pages.dev` preview hostnames are not on it — so sign-in fails
> with a CORS error on a preview deployment. This is LAUNCH.md item 16 and
> predates this work. Two ways round it, pick one:
>
> - **Local, no Worker change (recommended for this test):** build locally with
>   the two variables set and serve it on a port that *is* allowed —
>   `VITE_GOOGLE_MAPS_KEY=… VITE_GOOGLE_MAP_ID=… npm run build && npx vite preview --port 4173 --host 127.0.0.1`.
>   `http://127.0.0.1:4173` is already in `ALLOWED_ORIGINS`.
> - **Add the specific preview hostname** to `ALLOWED_ORIGINS` and redeploy the
>   Worker. This is a production Worker change; it is listed here for
>   completeness, not as a recommendation.

### 2.2 Mobile

The `eas-cli` is not installed in this repo, so the exact flag spellings below
could not be run and confirmed here — check them against `eas env:create --help`
and `eas update --help` for your version. The variable **names and values** are
the part that has been verified, and they are what matters.

```
cd apps/mobile

# preview only — production is deliberately absent from these commands
eas env:create --environment preview \
  --name EXPO_PUBLIC_GOOGLE_MAPS_KEY --value '<the shell key>' --visibility plaintext
eas env:create --environment preview \
  --name EXPO_PUBLIC_GOOGLE_MAP_ID --value '<the Map ID>' --visibility plaintext

eas env:list preview          # confirm both are there and production has neither

# Clear the bundler cache for this one — see the box below for why.
# Confirm the flag's spelling for your CLI version first:
#   eas update --help | grep -i cache
eas update --branch preview --channel preview \
  --message "Google basemap + Street View fixes (preview only)"
```

> **Metro's transform cache can bake a stale value into the bundle, silently.**
> Measured on this branch, not inferred:
>
> ```
> EXPO_PUBLIC_GOOGLE_MAPS_KEY=<value> EXPO_PUBLIC_GOOGLE_MAP_ID=<value> \
>   npx expo export --platform android
> ```
>
> With a warm cache, `src/lib/gmaps.ts` came out of the bundle compiled as
> `(null == void 0 ? void 0 : …) || ''` — **both variables substituted with
> `undefined`** — while `src/components/property/StreetView.tsx`, which had been
> edited that day and so missed the cache, got the real literal. The same export
> with `--clear` carried both values correctly.
>
> `EXPO_PUBLIC_*` values are not part of Metro's transform cache key, so a module
> you have not touched keeps whatever was inlined the last time it was
> transformed. `gmapsConfigured()` then returns false, the app quietly keeps its
> own renderer, and nothing errors — the failure looks exactly like not having
> set the variables at all.
>
> **So publish the preview update with the bundler cache cleared** — the
> `eas-cli` is not installed in this repo, so confirm the flag's exact spelling
> with `eas update --help` rather than taking one from here — and then check the
> result, which is the part that does not depend on a flag name:
>
> ```
> npx expo export --clear --platform android --output-dir /tmp/check
> grep -c '<the first 8 characters of your Map ID>' /tmp/check/www.bundle/*.js
> ```
>
> A count of `0` means the bundle has no Map ID and the Google map will not
> appear on the device, whatever EAS says the variables are.

`plaintext`, not `secret`, and the honesty is the point: these values are
compiled into the bundle and readable by anyone who unzips the APK. Marking them
secret would misdescribe what ships. The quota cap in step 1.3 is the actual
control.

**No new native build is required.** Nothing added a native module, a config
plugin or an `Info.plist` key, so `runtimeVersion` (`sdkVersion` →
`exposdk:57.0.0`) does not move and an OTA update carries the change.

Note that the `production` channel has never had an update published to it, so
the first `eas update --channel production` — when you eventually get there —
will be the first time that path has ever been exercised. Not a reason to do it
now; a reason to not do it casually.

### 2.3 Rolling back

Delete the two variables and redeploy / re-update. `gmapsConfigured()` becomes
false, every map falls back to the self-rendered renderer with MapTiler imagery,
and the app is byte-for-byte what it is today. There is no other switch to find.

---

## 3. Device checklist

Three columns to fill in: **pass / fail / not reached**. A blank is not a pass.

### 3.1 iPhone (TestFlight or a `preview` dev build)

**Map**
- [ ] The map loads and draws Google imagery (streets, with labels)
- [ ] SAT toggle switches to satellite/hybrid
- [ ] Satellite choice **survives leaving the screen and coming back**
- [ ] Satellite choice survives a full app restart
- [ ] Pins render in status colours
- [ ] Clustering groups pins when zoomed out, and a cluster tap zooms to it
- [ ] Tapping a pin opens the property sheet
- [ ] Tapping open map dismisses the sheet
- [ ] "Center on my location" works and the blue dot is where you are
- [ ] Pinch-zoom does not drop a new-lead pin (this was a reported bug)
- [ ] Zoom out fully — the map keeps going to a world view, not a neighbourhood

**Add a lead**
- [ ] The add-lead picker places a pin where you tap
- [ ] With the form open, a tap on an *existing* lead's dot still places the new
      pin rather than opening that lead

**Street View**
- [ ] A lead on a photographed street shows a photo
- [ ] The photo is **of the house**, not of the road ahead — this is the heading
      fix and it is the whole point
- [ ] A house set back from the road still gets a photo — this is the radius fix
- [ ] A genuinely uncovered rural lead reads
      *"No Street View imagery is available near this property"*
- [ ] Nothing anywhere reads "No photo of this house yet" — that sentence is gone

**Street View failure states** *(needs a deliberate break — easiest is to
temporarily disable Street View Static API in the console, then re-enable)*
- [ ] With the API disabled, the frame reads
      *"Property imagery is temporarily unavailable"*
- [ ] It does **not** claim the street is unphotographed
- [ ] Re-enabling the API restores the photo without an app restart

**Console and roles**
- [ ] Signed in as **admin**: no "Admin console" row in More (expected — the
      console is not in the phone bundle; see §4)
- [ ] Signed in as **rep**: no console link anywhere, and typing `/admin`
      lands on Today rather than a blank screen

### 3.2 Android (`preview` APK)

Everything in 3.1, plus the four that are Android-specific:

- [ ] **The map is not blank.** This is the highest-risk unknown in the whole
      change: Google's vector renderer compiles WebAssembly and runs label
      layout in a worker created from a `blob:` URL, and Android System WebView
      has historically blocked blob-URL workers under a `file://` origin
- [ ] Labels and roads paint correctly (a blank grey rectangle with the chips
      floating on it is the failure)
- [ ] If the map **does** fail, it falls back to the self-rendered map with
      MapTiler tiles within ~10 seconds rather than staying grey
- [ ] The app does not crash or reset to Home on any map interaction

> If the blob-worker problem bites: the fix is **not** a code change. Switch the
> Map ID to **raster** in the Cloud console — raster needs no WebAssembly and no
> blob worker. Slower and less pretty, and it costs nothing else.

### 3.3 Desktop (the office console)

- [ ] `/admin/territories` — the map draws Google imagery
- [ ] **Drawing a territory**: each tap places a visible white vertex handle
- [ ] The outline is dashed while under three points and fills in at three
- [ ] Tapping *inside* the filled shape adds a vertex — it does not get
      swallowed by the polygon
- [ ] Tapping *on a lead pin* while drawing adds a vertex — it does not open
      the lead
- [ ] Tapping *on a cluster bubble* while drawing adds a vertex — it does not
      zoom
- [ ] Undo point / Start over clear the shape from the map
- [ ] "Create with N leads" counts the same N as the self-rendered map did
- [ ] `/admin/lists` — the same, plus a saved list's boundary displays read-only
- [ ] `/admin/leads` — the lasso selects the same leads it used to
- [ ] Territory rename and delete still work
- [ ] Street View shows on a lead's detail

**Role safety, on desktop where the console exists**
- [ ] **rep** → no console link in the side rail; `/admin` by URL is refused
      with "Not available for your role"
- [ ] **manager** → console visible; no Settings, no Clients; both refused by URL
- [ ] **admin** → console visible; Settings yes, Clients no
- [ ] **super admin** → everything

---

## 4. The Admin Console on a phone — what is actually true

Worth stating plainly, because "Admin Console can't be reached in app" has been
reported as a bug and it is not one:

**The console is deliberately absent from the native bundle.**
`apps/mobile/metro.config.js` swaps `src/adminRoutes.tsx` for
`apps/mobile/src/admin-routes-stub.tsx`, which returns `null`. So inside the
shell the `/admin/*` routes do not exist, and `App`'s catch-all sends `/admin`
to `/today`.

It is not a role check, not a breakpoint, and not `Platform.OS`. The console
screens themselves are mobile-first and gated at 390px and 412px by
`verify:console`; they render fine on a phone *on the web*.

What was fixed here is the navigation half: `More` already hid the dead link in
the shell, and the **side rail did not** — so on any native surface wide enough
for the rail (an Android tablet, a large display mode) a manager was offered a
Console link that silently dropped them on the rep's Today screen. That link is
now hidden in the shell too, and `verify:console` holds it.

**Putting the console in the phone bundle is a separate decision and has not
been made.** It means removing the Metro swap and converting
`src/adminRoutes.tsx`'s eleven `lazy()` imports to static ones — the dynamic
imports are why the swap exists, because `expo export` could not serialise the
shared chunk they produced. It adds ~9,300 lines of desktop-first console to
every rep's download. Ask for it explicitly if it is wanted.
