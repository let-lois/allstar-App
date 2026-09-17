# The mobile app: what was broken, and what it is now

A systematic audit of the All-Star Expo app against the working web app, the
root causes found, and what remains. Written 2026-09-17.

Read `MIGRATION_PROGRESS.md` for where the native rewrite is going. This
document is about why the app that exists today does not work on a phone.

---

## 1. The architecture, which is not what the plan assumed

There are no native screens. `apps/mobile` is three route files and one
component:

```
src/app/_layout.tsx              native shell
src/app/index.tsx                native route — owns the apiFetch action
src/app/checkpoint.tsx           native route
src/components/allstar-web.tsx   'use dom'  ← the entire product
```

`allstar-web.tsx` carries `'use dom'`, so Metro bundles it **and everything it
imports** as web code and hands it to a webview. It imports `@web/App`: the
whole Vite app, all 30 routes, `react-router-dom`, IndexedDB, Tailwind. iOS and
Android run the same web app the office runs, inside a webview loaded from
`file://`.

Three consequences worth stating before anybody plans work against this:

- There are **no Expo Router paths to audit**, no web-only components to port,
  no `localStorage`-versus-`SecureStore` split to make, and no
  `react-native-maps`. There is one screen and it is a webview.
- `packages/core` — 3,589 lines, compiled with `lib: ["ES2020"]` and
  `types: []` so platform APIs are a type error — is the shared domain logic
  waiting for native screens. It is inert today.
- The admin console is **not in the phone bundle**. `metro.config.js` swaps
  `adminRoutes.tsx` for a stub, and the exported bundle contains zero
  references to `AdminLeads`, `AdminLists` or `AdminReports`. CSV export and
  import are desktop jobs.

## 2. Root causes

Each one was established from the code or from a gate, not inferred. None of
them was a missing Apple or Google key, though two keys are still owed — see
§8.

### 2.1 The webview could not do what the app needs — *fixed*

`expo/src/dom/webview-wrapper.tsx` defaults `useExpoDOMWebView` to `true`, so
the shell ran on `@expo/dom-webview`. Its Android implementation
(`DomWebView.kt:194-206`) sets `javaScriptEnabled` and two file-access flags
and stops. It installs **no `WebChromeClient` at all**. Four silent failures
follow:

| What | Why | Effect on a rep |
| --- | --- | --- |
| `domStorageEnabled` never set; Android's default is `false` | IndexedDB requires DOM storage | The app is offline-first and keeps the session token in IndexedDB. It falls back to an in-memory store, so **a rep is signed out on every cold start and a day's work never reaches disk** |
| no `onGeolocationPermissionsShowPrompt` | Android WebView denies geolocation without it | No prompt, no error. The route cannot order from where the rep stands; a tapped house has no position |
| no `onShowFileChooser` | Android WebView needs the host to present the picker | `<input type="file">` does nothing. **The camera and photo library are unreachable** |
| no alert/confirm handling on either platform | iOS implements only the prompt panel, hijacked for its own eval bridge | Both `window.confirm` calls silently answer no |

It also has **no navigation interception on either platform** — no
`shouldOverrideUrlLoading`, no `decidePolicyFor`.

`react-native-webview` implements all of it, requests the Android runtime
permission itself, and sets `domStorageEnabled` at view creation
(`RNCWebViewManagerImpl.kt:78`). `useExpoDOMWebView: false` is the documented
opt-out for SDK 56+.

### 2.2 `geolocationEnabled: true` was dead code — *fixed*

`DOMProps extends Omit<RNWebViewProps, 'source'>`, so it typechecks;
`@expo/dom-webview` does not declare the prop and has no geolocation path. It
read as a fix and did nothing. It is real now that the webview beneath it
implements it.

### 2.3 A `target="_blank"` ate the app — *fixed*

Four links in the web app open a new window, one of them the turn-by-turn
handoff on Navigate. A webview has nowhere to put a new window, so the URL
loaded **in place**: the All-Star app became Google Maps, with no back button
and no way out but force-quitting. Expo's own docs say the same of anchors —
"these will change the DOM component origin in a way that users may not be able
to navigate back from".

Nothing but the shell's own `file://` page navigates the webview now.
Directions go to `Linking.openURL` so they land in the real Maps app;
everything else opens in the in-app browser.

### 2.4 The logo was broken, twice — *fixed*

PR #147 claimed this was fixed by replacing `src="/logo.png"` with an import.
The check was the problem: the bundle was grepped for the asset's hash rather
than asked whether the file resolved.

Metro emits a **bare relative** URL for an imported asset, so the file must sit
beside the DOM component's page — and Expo's two export paths disagree about
whether it does:

- `exportEmbedAsync.js:350-357` prefixes each DOM asset's `httpServerLocation`
  with `www.bundle`, so a **dev, preview or production build resolves it**.
- `exportDomComponents.js` — `expo export`, and therefore **EAS Update** — does
  not. The image goes to `dist/assets/` and the page asks for a missing
  sibling.

So this was a property of Expo Go plus EAS Update, and a real build was never
affected. No single relative URL is right for both layouts; both are right
about a URL with nothing to resolve, so the two images are now generated
data-URI modules swapped in by `metro.config.js`. The web build keeps its own
hashed PNG.

### 2.5 Every photo upload threw — *fixed*

`apiUploadPhoto` passes a `Blob` as `raw`. The bridge rejected any non-string
body with a `TypeError` whose comment claimed "nothing sends one today", and
`verify-bridge.mjs` had an assertion **locking that in** — it tested that a
Blob body throws. Bytes now cross as base64 and are decoded to a typed array on
the native side.

### 2.6 No request had a deadline — *fixed*

`request()` gives every call one (20s, 45s for a photo down, 60s for one up)
and arms it with `signal`. A signal cannot cross a JSON bridge, and the shim
dropped it, so none of those deadlines existed on a device: a stalled cellular
request hung the screen forever. It is raced now, rejecting with the same
`AbortError` a browser raises.

### 2.7 iOS would have been killed by its own camera — *fixed*

`app.json` declared only `NSLocationWhenInUseUsageDescription`. iOS terminates
an app that reaches the camera with no usage description, so the first tap on
the camera button in `PhotoStrip` was a crash, not a broken button.

### 2.8 Address lookup cannot work in the shell, and no key fixes it — *fixed, needs a deploy*

`reverseGeocode.ts` asks Google through the Maps JavaScript geocoder on the
referrer-restricted browser key. A DOM component's page is loaded from
`file://` so it sends **no `Referer` at all**, and an HTTP-referrer restriction
is the only application restriction the Maps JavaScript API supports. An iOS-
or Android-restricted key validates a bundle identifier sent by the *native*
Maps SDK, which a webview running JavaScript is not.

**A key restricted to `com.allstarhomesolutions.allstar` will not fix this.**
Earlier advice in this project said it would; that was wrong.

The options were an unrestricted key inside the shipped bundle — liftable by
anybody — or the server. `POST /api/geocode/reverse` now does it on the
Worker's key, metered per company through `geocodeKeysFor` and `recordLookups`
like the import path. Google's `address_components` come back untouched so
`address.ts` keeps doing the parsing for both platforms.

### 2.9 One dependency finding, audited and harmless

`expo-doctor`: 18/21, two failures being this sandbox's blocked network. The
real one is duplicate `react`/`react-dom` — 19.2.3 in `apps/mobile`, 18.3.1 at
the root — so React-18-era web code runs on **React 19** in the shell.

Audited rather than left as a worry, and it is clear. The built DOM bundle
carries exactly **one** copy of React, so there is no invalid-hook crash. And
the web app uses none of the APIs React 19 removed: no `defaultProps` or
`propTypes` on a function component, no string refs, no `findDOMNode`, no
legacy `contextTypes`, no `ReactDOM.render`, and in fact no `forwardRef`
anywhere. `verify:shell` also drives routing — sign-in through to a
signed-in screen, on `react-router-dom` 6.30.6 — under the React 19 bundle and
reports no runtime errors.

So this is dependency hygiene rather than a defect: two Reacts in one
`node_modules` tree is worth resolving, and it is not why anything was broken.

## 3. Feature matrix

Legend: ✅ verified · ⚠️ degraded, by design or otherwise · ❌ broken ·
⬜ **not verified on a device** — the code path is fixed or believed sound and
has not been run on hardware.

Nothing in the iOS or Android columns is marked ✅ unless a gate proves it.
`verify:shell` boots the real exported bundle from a `file://` URL in Chromium
with a faithful native bridge, which is real evidence for boot, layout, assets
and the API path — and no evidence at all about WKWebView or Android's WebView.

| Feature | Web | iOS | Android | API | Was broken by | Now |
| --- | --- | --- | --- | --- | --- | --- |
| Boot / splash | ✅ | ✅ | ✅ | — | — | `verify:shell` |
| Login | ✅ | ✅ | ✅ | `/api/auth/login` | 2.1 CORS→bridge | gate signs in over the bridge |
| Session survives a restart | ✅ | ⬜ | ⬜ | — | 2.1 DOM storage off | webview swap |
| Wordmark / icons | ✅ | ✅ | ✅ | — | 2.4 | `verify:shell` asks the DOM |
| Safe area / page box | ✅ | ⬜ | ⬜ | — | half-specified box | `verify:shell` checks the box |
| Today / Overview | ✅ | ⬜ | ⬜ | `/api/bootstrap` | 2.1 storage, 2.2 location | — |
| Map — pins, tap, lasso | ✅ | ⬜ | ⬜ | — | 2.2 location | — |
| Map — basemap imagery | ✅ | ❌ | ❌ | — | no MapTiler key set | **owed: §8** |
| Map — Google basemap | ✅ | ⚠️ | ⚠️ | — | no JS key usable from `file://` | falls back to own renderer, by design |
| Tap a house → address | ✅ | ⬜ | ⬜ | `/api/geocode/reverse` | 2.8 | needs a Worker deploy |
| Add lead / edit lead | ✅ | ⬜ | ⬜ | `/api/mutations` | 2.1 storage | — |
| Lead photos (camera) | ✅ | ⬜ | ⬜ | `POST /api/photos/:id` | 2.1 picker, 2.5 body, 2.7 plist | three fixes, untested on device |
| Lead photos (library) | ✅ | ⬜ | ⬜ | same | 2.1, 2.5, 2.7 | — |
| Lists / assigned lists | ✅ | ⬜ | ⬜ | `/api/lists` | 2.1 storage | — |
| Pipeline | ✅ | ⬜ | ⬜ | — | layout, 2.1 | needs a device read |
| Route | ✅ | ⬜ | ⬜ | `/api/directions` | 2.2 location | — |
| Navigate (handoff) | ✅ | ⬜ | ⬜ | — | 2.3 — it ate the app | `Linking.openURL` |
| Street View | ✅ | ⚠️ | ⚠️ | — | no Google key | placeholder, by design |
| Visit Mode | ✅ | ⬜ | ⬜ | `/api/mutations` | 2.1, 2.5 | — |
| Team / standings / rep | ✅ | ⬜ | ⬜ | `/api/users` | 2.1 storage | — |
| Profile / avatar | ✅ | ⬜ | ⬜ | `/api/me/profile` | 2.1 picker, 2.7 | — |
| Badge / verify badge | ✅ | ⬜ | ⬜ | `/api/me/badge` | `EXPO_PUBLIC_ORIGIN` | set in all three EAS envs |
| Onboarding | ✅ | ⬜ | ⬜ | `/api/me/onboarding` | 2.1 picker, 2.7 | — |
| Offline queue / sync | ✅ | ⬜ | ⬜ | `/api/mutations` | 2.1 storage | this is the one to test hardest |
| Offline map download | ✅ | ⬜ | ⬜ | — | Cache API on `file://` unverified | untested |
| CSV export | ✅ | n/a | n/a | `/api/leads/export.csv` | — | console-only; not in the phone bundle |
| Admin console | ✅ | n/a | n/a | — | — | stubbed out of the bundle, deliberately |

## 4. API status

Every call from the phone goes over the native bridge (`api-bridge.ts`) because
the webview's origin is `file://` and the Worker's `corsHeaders()` echoes
nothing for `Origin: null`. React Native's `fetch` is not a browser, so CORS
does not apply. **No server CORS change was made, and none should be** — adding
`null` to `ALLOWED_ORIGINS` would let every sandboxed page in the world talk to
the API.

`verify:bridge` covers the bridge in 24 checks: URL, method, headers, the
Authorization header, text and binary bodies both ways, the null-body statuses,
a missing native action, and the abort path.

New: `POST /api/geocode/reverse`. **Not deployed.**

Unreachable from this sandbox — the environment's network policy answers 403 to
CONNECT for both `allstar.letlois.com` and the Worker — so no call in this
table has been made against the live API from here. Everything is gated against
mocks.

## 5. Environment variables

Names only.

| Variable | Web | Expo | Backend | Secret | State |
| --- | --- | --- | --- | --- | --- |
| `VITE_API_URL` / `EXPO_PUBLIC_API_URL` | ✅ | — | — | no | unset in EAS; falls back to the deployed Worker, which is what a shipping build wants |
| `VITE_PUBLIC_ORIGIN` / `EXPO_PUBLIC_ORIGIN` | ✅ | ✅ | — | no | set in all three EAS environments |
| `VITE_MAPTILER_KEY` / `EXPO_PUBLIC_MAPTILER_KEY` | ✅ | ❌ | — | no | **unset — this is why the map has no imagery** |
| `VITE_GOOGLE_MAPS_KEY` / `EXPO_PUBLIC_GOOGLE_MAPS_KEY` | ✅ | ❌ | — | no | unset, and cannot help in the shell (§2.8) |
| `VITE_GOOGLE_MAP_ID` / `EXPO_PUBLIC_GOOGLE_MAP_ID` | ✅ | ❌ | — | no | unset; all-or-nothing with the key above |
| `GOOGLE_MAPS_API_KEY` | — | — | ✅ | **yes** | Worker-side; server geocoding. Never in a client bundle |
| `GOOGLE_GEOCODE_BASE_URL` | — | — | ✅ | no | test seam; unset in production |
| `CENSUS_BASE_URL` | — | — | ✅ | no | test seam |

No private secret is exposed through `EXPO_PUBLIC_*`. Anything prefixed that
way is compiled into the app and readable by anybody who downloads it; the
three unset map keys above are all public-by-design client keys and must be
restricted at the provider.

## 6. iOS

Configured: `bundleIdentifier`, `scheme`, `version`, `supportsTablet: false`,
adaptive icons, splash, `ITSAppUsesNonExemptEncryption: false`,
`NSLocationWhenInUseUsageDescription`, and now `NSCameraUsageDescription` and
`NSPhotoLibraryUsageDescription`.

Remaining: `ascAppId` in `eas.json` `submit.production.ios` (needs the App
Store Connect record), a Privacy Policy URL, the privacy-nutrition
declarations, in-app account deletion, and a build number strategy —
`appVersionSource: remote` with `autoIncrement` is set, which covers it once
the first build runs.

## 7. Android

Configured: `package`, adaptive icons, `predictiveBackGestureEnabled: false`,
`ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`.

Deliberately **not** added: `CAMERA`.
`RNCWebViewModuleImpl.needsCameraPermission` only requests it if the manifest
declares it, and Android does not require it when capture is delegated to the
camera app via `ACTION_IMAGE_CAPTURE` — which is what the file chooser does.
Declaring it would add a runtime prompt and a Play Store declaration for a
permission the app does not use.

Remaining: Play Console record, app signing, Data Safety declarations, target
API level check, Privacy Policy URL, account deletion.

No background location anywhere, and none is needed: location is used only
while a rep has the app open.

## 8. Expo Go versus a development build

**Works in Expo Go:** everything the shell does. DOM components are supported
in Expo Go, and `runtimeVersion` is the `sdkVersion` policy specifically so
published updates load there.

**Requires a development or preview build:** honest asset resolution. The
export-path asymmetry in §2.4 means Expo Go plus EAS Update shows faults a real
build does not have. **Test on a `preview` build.** Expo Go will waste time on
phantoms.

**Requires a production build:** store submission, and the first `eas build`
that lets the GitHub repo be linked to the Expo project with base directory
`apps/mobile`.

## 9. Remaining blockers, and who owns them

Ours:

- Deploy the Worker so `/api/geocode/reverse` exists. Lou or Curtis, through
  the company's Cloudflare process.
- Run a `preview` build on a real iPhone and a real Android device. Nothing in
  §3's ⬜ column becomes ✅ without it.

Needs credentials or an account:

- **A MapTiler key**, set as an EAS environment variable in all three
  environments. Without it the map has no imagery on a phone.
- **A Google server-side geocoding key** on the Worker, with the **Geocoding
  API** enabled — a separate switch from Maps JavaScript and Places, and easy
  to miss when the map is plainly working. Not the browser key.
- App Store Connect and Play Console records.

Needs a decision:

- Whether the Google basemap is wanted on a phone at all. It cannot be secured
  from a `file://` webview, and the app's own renderer is the fallback. The
  honest answer is probably to leave it to the web and let the phone use
  MapTiler.

Blocked here specifically:

- This sandbox cannot reach `allstar.letlois.com` or the Worker — the
  environment's network policy answers 403 to CONNECT. So no end-to-end test
  against the real API can run from here. Either add those hosts to the
  environment's network policy, or those tests happen on a device.

## 10. Phase 1 readiness

**Not ready, and not testable as ready from here.**

What is established: the shell boots from `file://`, renders sign-in, refuses a
wrong password with the server's own message, accepts a right one, sends the
bearer token, decodes every asset, and owns the page box — all proved by
`verify:shell` against the real exported bundle. The bridge carries text and
binary in both directions and honours a deadline, proved by `verify:bridge` in
24 sabotage-tested checks. 80 gates pass.

What is not established: any of it on hardware. The webview swap in §2.1 is the
single largest change and Chromium cannot observe it — it rests on reading
`@expo/dom-webview`'s and `react-native-webview`'s native sources. Storage
persistence across a cold start, the camera, geolocation prompts and the
directions handoff all need a device.

The acceptance tests in the Phase 1 plan also need re-scoping against §1: Test
E (CSV export) is a desktop console workflow, not a mobile one, and Test B
(manager creates and assigns a list) is mostly console too. The rep half —
Test A and Test C — is the mobile app.
