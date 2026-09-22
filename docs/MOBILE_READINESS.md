# Mobile readiness audit — Expo, iOS, Android, and the stores

Written 2026-09-22 against `main` at `c75f5f3` plus the branch
`claude/mobile-first-field-sales-kflg1x`. This is the successor to
`MOBILE_AUDIT.md` (2026-09-17): that document established the architecture and
fixed twelve root causes; this one answers the questions that were still open
after it — chiefly **why Android shows a black screen** — and lays out the
order of work to a store submission.

Every claim below is marked by how it was established:

- **[source]** read in the code that ships, with a file and line
- **[repro]** reproduced in Chromium against the real exported bundle
- **[gate]** covered by an automated gate in the suite
- **[device]** confirmed on a phone by someone (from the commit record)
- **[unverified]** believed sound, not yet run on hardware from here

Nothing marked [source] or [repro] should be mistaken for [device]. This
sandbox has no simulator and cannot reach the Worker or `allstar.letlois.com`.

---

## 1. Architecture

There are no native screens. The native app is a shell around the web app:

```
apps/mobile/src/app/_layout.tsx          Expo Router stack, no chrome
apps/mobile/src/app/index.tsx            the one real route: hosts the DOM shell,
                                         owns apiFetch (the native fetch bridge),
                                         the Android back handler, the URL gate
apps/mobile/src/app/checkpoint.tsx       a proof-of-shared-package screen; not linked
apps/mobile/src/components/allstar-web.tsx   'use dom' — imports @web/App: the whole
                                         Vite app, all rep routes, IndexedDB, Tailwind
apps/mobile/src/lib/api-bridge.ts        replaces fetch inside the webview so API calls
                                         cross to React Native, which has no CORS
packages/core                            3,589 lines of shared domain logic; inert today
```

| | |
| --- | --- |
| Expo SDK | 57.0.23 (`expo@57.0.23`; doctor wants ~57.0.24) |
| React Native | 0.86.3, New Architecture (SDK 57 default) |
| React (native) | 19.2.3 in `apps/mobile`; the web app hoists 18.3.1 at the root. The DOM bundle carries exactly one React, 19.2.3 [source: bundle grep] |
| Router | `expo-router` 57.0.21, `main: expo-router/entry`, one stack, `headerShown: false` |
| Web app inside the shell | `react-router-dom` 6 under `MemoryRouter`; Zustand; IndexedDB via `idb` |
| TypeScript | root `tsc` clean (0 errors); `packages/core` clean; `apps/mobile` 48 errors in this environment — see §13 |
| API | Cloudflare Worker (`allstar-api`), reached only over the native bridge |
| Auth | bearer token kept in IndexedDB by the web app; no cookies |
| Env | `process.env.EXPO_PUBLIC_*` read at seven sites; Vite `define`s the same names from `VITE_*`; Metro inlines them natively |
| Updates | `expo-updates` 57.0.22, `runtimeVersion.policy: sdkVersion`, `updates.url` set, project `497739ce-…` |
| Native deps the shell uses | `react-native-webview`, `expo-web-browser`, `expo-linking`, `expo-splash-screen`, `react-native-reanimated`/`worklets` (splash overlay), `react-native-safe-area-context` |

How the page loads [source: `expo/src/dom/base.ts`]: from a **dev server** it is
`http://<host>:8081/_expo/@dom/<file>`; from an **EAS Update** (which is what
Expo Go runs) it is a `file://` URL inside expo-updates' `.expo-internal`
directory; from an **embedded build** it is `file:///android_asset/www.bundle/…`
on Android and `www.bundle/…` on iOS. The page's origin is therefore `file://`
everywhere except the dev server, which is why every API call goes over the
bridge and why `ALLOWED_ORIGINS` must never gain `null` — `MOBILE_SETUP.md`
already says so, and the Capacitor origins added on this branch earlier in the
week were reverted for that reason (`21e73f4`).

## 2. Why Android cannot run the app — P0, root cause established

**[repro] [source]** The DOM component's HTML page (Expo's template; see
`/tmp`-exported `www.bundle/<hash>.html`) contains, inline and synchronous, before
the bundle script:

```js
injectedObject = JSON.parse(window.ReactNativeWebView.injectedObjectJson());
// on failure: throw new Error('Failed to parse injectedObjectJson: ' + e.message)
window.$$EXPO_DOM_HOST_OS = injectedObject.EXPO_DOM_HOST_OS;
window.$$EXPO_INITIAL_PROPS = injectedObject.initialProps;
```

and the bundle's entry (`expo/src/dom/dom-entry.tsx:61-66`) throws
`Top OS ($$EXPO_DOM_HOST_OS) is not defined` if that global is missing —
**before** its own try/catch, so nothing renders.

The shell runs on `react-native-webview` (`useExpoDOMWebView: false`,
`apps/mobile/src/app/index.tsx:182-236`), chosen in #148 because Expo's own
`@expo/dom-webview` installs no `WebChromeClient` on Android. The two webviews
provide `injectedObjectJson` in opposite ways:

| | iOS | Android |
| --- | --- | --- |
| `react-native-webview` 13.16.1 | `WKUserScript` at document start — present before any page script (`apple/RNCWebViewImpl.m:1724-1940`) | `evaluateJavascript()` from `injectJavascriptObject()` (`RNCWebView.java:275-283`), called at view creation (into `about:blank`), when the prop is set, on `onPageStarted` **only if `injectedJavaScriptBeforeContentLoaded` is non-empty** (`RNCWebView.java:311-318`, `RNCWebViewClient.java:85-91`), and on `onPageFinished`. No document-start script anywhere in the Android sources |
| `@expo/dom-webview` 57.0.1 | native | native `@JavascriptInterface` (`RNCWebViewBridge.kt:8-10`, `DomWebView.kt:202`) — present at document start |

Expo's wrapper (`expo/src/dom/webview-wrapper.tsx:143-160`) sets
`injectedJavaScriptObject` and `injectedJavaScript`, **not**
`injectedJavaScriptBeforeContentLoaded`. So on Android with
`react-native-webview`, between the navigation to the page and `onPageFinished`
there is no injection at all. `window.ReactNativeWebView` exists from document
start (AndroidX `WebMessageListener`, `RNCWebView.java:252-266`) but carries only
`postMessage`. The inline script throws, the globals are never set, the bundle
throws on entry, and the screen stays black.

Reproduced against the real exported page in Chromium with the two boot orders
(`scripts/repro/android-injection-order.mjs <path to www.bundle>`):

```
=== iOS-like: injectedObjectJson at document start ===
root text length: 193 -> "Field sales, built for the phone. Email Password SHOW Sign i"
errors: none

=== Android-like: injectedObjectJson only after load ===
root text length: 0 (EMPTY - black screen)
errors: Failed to parse injectedObjectJson: window.ReactNativeWebView.injectedObjectJson is not a function
        Top OS ($$EXPO_DOM_HOST_OS) is not defined. This is a bug in the DOM Component runtime.
```

This is the black screen #153 recorded ("83 gates green, an OTA update
published, and a black screen on an Android phone") and could not explain.
`verify:shell` stubs `injectedObjectJson` as always present
(`scripts/verify-shell.mjs:185-193`), which is the iOS order, so it is green on
both hosts by construction.

Three things follow, and they decide the whole plan:

1. **It is not a key, a permission, a URL or an env var.** The page never gets
   as far as reading any of them.
2. **Neither webview Expo Go ships on Android works for this app.**
   `react-native-webview` cannot provide the object at document start;
   `@expo/dom-webview` can, but has no `WebChromeClient` — no DOM storage
   (the session and the day's work), no geolocation prompt, no file chooser
   (camera), no confirm dialogs (`DomWebView.kt:197-200` sets `javaScriptEnabled`
   and two file flags and stops). Upstream `react-native-webview` 13.16.2,
   13.17.0 and 14.0.1 all still inject with `evaluateJavascript` (checked in the
   published tarballs), so no upgrade fixes it either.
3. **Fixing it needs native code, which Expo Go cannot carry.** That is the
   Development Build the brief asks about, and the answer is yes, for Android
   it is required — not for a feature, for boot.

### Issue P0-1 — Android boots to a black screen

- **Platform:** Android (Expo Go via EAS Update; also any build using
  `react-native-webview` as-is)
- **Root cause:** above.
- **Fix:** give Android a document-start `injectedObjectJson`. The smallest
  correct change is a patch to `react-native-webview`'s Android side registering
  a tiny `@JavascriptInterface` object and, where the WebView supports it,
  `WebViewCompat.addDocumentStartJavaScript` mapping
  `ReactNativeWebView.injectedObjectJson` to it — the same shape
  `@expo/dom-webview` already uses. Shipped as `patches/react-native-webview+13.16.1.patch`
  via `patch-package`, applied in `postinstall`, and worth sending upstream.
  It only takes effect in a build that compiles native code: **development,
  preview, production — not Expo Go.**
- **What is not the fix:** setting `dom.injectedJavaScriptBeforeContentLoaded: 'true;'`
  makes `react-native-webview` re-inject the object in `onPageStarted`
  (`RNCWebView.java:311-318`). Because the page's body scripts are blocked
  behind its stylesheet, that injection will *usually* land first — but it is
  an `evaluateJavascript` racing the parser, and nothing guarantees the order.
  It may unblock QA in Expo Go on Android while the build pipeline is set up;
  it must not ship as the fix.
- **Files:** `apps/mobile/patches/react-native-webview+13.16.1.patch` (new),
  `apps/mobile/package.json` (`postinstall`, `patch-package` devDependency),
  `scripts/verify-shell.mjs` (an Android-order boot, so the gate can see this)
- **Risk:** Medium — native patch, but ~20 lines mirroring a shipped
  implementation, and the failure mode is the one we already have.
- **Verification:** `verify:shellandroid` booting the exported page with
  `injectedObjectJson` absent at document start must **fail** before the patch
  (it does today, by the repro above) and the patched build must render the
  sign-in screen on an Android device; then sign in, force-quit, reopen —
  still signed in.

### Issue P0-2 — the development profile cannot be built as configured

- **Platform:** both
- **Root cause:** `eas.json` `build.development` has `developmentClient: true`,
  but `expo-dev-client` is not in `apps/mobile/package.json` and not installed.
- **Fix:** `cd apps/mobile && npx expo install expo-dev-client`.
- **Files:** `apps/mobile/package.json`
- **Risk:** Low
- **Verification:** `eas build --profile development --platform android`
  produces an installable dev client; `npx expo start --dev-client` connects.

### Issue P0-3 — `expo start` on iOS opens the dev URL in Safari and leaves the webview blank

- **Platform:** iOS (dev server only). Android is not consulted for the
  initial load (`shouldOverrideUrlLoading` is not called for `loadUrl`).
- **Root cause [source]:** the shell's `onShouldStartLoadWithRequest`
  (`apps/mobile/src/app/index.tsx:120-124`) allows only `file://` and `about:`,
  and hands anything else to the OS. From a dev server the DOM page is
  `http://<host>:8081/_expo/@dom/…` (`expo/src/dom/base.ts:37-41`). WKWebView
  asks the JS gate for **every** navigation including the first
  (`apple/RNCWebViewImpl.m:1365-1404`), so the shell refuses its own page and
  `WebBrowser.openBrowserAsync` opens it in an in-app Safari sheet.
- **Fix:** in `__DEV__`, also allow the dev-server origin, read the way Expo
  reads it (`react-native/Libraries/Core/Devtools/getDevServer`). Keep the
  production rule exactly as it is.
- **Files:** `apps/mobile/src/app/index.tsx`
- **Risk:** Low
- **Verification:** `npx expo start` → open on an iPhone → the app renders
  inside the shell; a Navigate hand-off still opens Apple Maps; Street View
  still opens the in-app browser.

### Issue P0-4 — a release build cannot say what went wrong

- **Platform:** Android
- **Root cause [source]:** `RNCWebChromeClient.java:118-124` returns `true`
  from `onConsoleMessage` unless `ReactBuildConfig.DEBUG`, which tells WebView
  the message is handled — so nothing reaches logcat. The same build config
  gates `WebView.setWebContentsDebuggingEnabled`
  (`RNCWebViewManagerImpl.kt:93-95`), so `chrome://inspect` is unavailable too.
  A preview APK that renders a blank page therefore has no channel at all for
  the reason.
- **Observed [device]:** three preview builds showed a blank page; a full
  `adb logcat` of a cold boot (1,438 lines) contained no `CONSOLE`, `Uncaught`,
  `EXPO_DOM` or `ERR_` line, because there was nothing to catch.
- **Fix:** the same `patch-package` patch now forwards **error-level** console
  messages to logcat under the tag `RNCWebViewConsole`, with source and line.
  Error level only: the web app calls `console.error` nowhere itself, so
  everything at that level is an uncaught exception or the browser's own
  complaint, and a rep's ordinary session stays out of logcat.
- **Files:** `apps/mobile/patches/react-native-webview+13.16.1.patch`
- **Risk:** Low
- **Verification:** `verify:webview-patch` reads the installed
  `RNCWebChromeClient.java`, isolates `onConsoleMessage`, and checks the
  forwarding sits **below** the debug branch at error level only; restoring the
  pristine file fails four named checks.

### What the blank preview APK ruled out

Worth recording, because it was the leading theory and it was wrong. Expo's two
export paths lay DOM assets out differently (§2.4 of `MOBILE_AUDIT.md`), so the
embedded page was suspected of asking for a script that was not there. It is
not:

- **[repro]** `expo export:embed --platform android` here produces
  `assets/www.bundle/<hash>.html` alongside
  `assets/www.bundle/_expo/static/js/web/entry-<hash>.js`, and the page asks for
  `./_expo/static/js/web/entry-<hash>.js`. That resolves. The flat layout seen
  from `expo export` is the `useMd5Filename` path
  (`exportDomComponents.js:78-110`), and each layout is internally consistent.
- **[device]** unzipping the preview APK gives exactly the same three files and
  the same reference.
- **[repro]** `scripts/repro/android-injection-order.mjs` pointed at the
  *embedded* page still renders the sign-in screen under the iOS injection
  order and nothing under the Android one — so the page in the APK is sound and
  the boot order remains the open question.

## 3. iOS — what is known and what is likely

The iPhone opens because iOS gets the injection order right. Everything the
previous audit fixed is in the shipped bundle; the reports from devices since
(#149, #152) were fixed and are in `main`. What remains is in three groups.

**Confirmed on a device [device]:** the session survives a force-quit;
MapTiler imagery draws when a key is present (because `?` is still in the
key's allowed origins — `LAUNCH.md` item 4).

**High-confidence from source, not yet seen on a device [source] [unverified]:**

| Issue | Where | Why | Fix |
| --- | --- | --- | --- |
| **Call, Text and Email do nothing** | `index.tsx:115-118` `handOff()` | `<a href="tel:…">` (`CommActions.tsx:74-105`, `PropertyRow.tsx:59`) navigates the webview; the gate refuses it and calls `WebBrowser.openBrowserAsync('tel:…')`, which only opens http(s). The tap is swallowed. Both platforms | non-http(s) schemes → `Linking.openURL` |
| **Offline map download cannot work** | `src/lib/tiles.ts`, `public/sw.js`, `FieldMap.tsx:842` | tiles are written to Cache Storage and served back only by the service worker. Under `file://` there is no service worker on either platform and `caches` is absent, so `tileStorageAvailable()` returns false and the download declines. Latent until a MapTiler key is set for the phone | **Fixed on this branch:** tiles live in IndexedDB (DB v7) and `FieldMap` reads them in app code; `verify:offlinemaps` proves the map draws from storage with no worker and no network. Still latent on the phone until a MapTiler key is set |
| **No basemap imagery** | server | **Fixed on this branch:** tiles are proxied through the Worker (`/api/tiles`, `MAPTILER_API_KEY` secret, `smoke:tiles`); the app reads `/api/health` → `config.tiles`. Latent until the secret is set — `MOBILE_SETUP.md` step 4 |
| **Tap-a-house address and Street View depend on a Worker deploy** | `api/src/geocode.ts`, `api/src/streetview.ts` | both are in `main`; whether they are live is `version.commit` at `/api/health`, unreachable from here | confirm the deploy |

**Reported as "many bugs", not yet enumerable from here:** a webview keyboard in
Visit Mode (the known worst thing about a wrapped app; `--app-h` is pinned to
`visualViewport.height` on the web side), a "visual nuisance somewhere in the
tutorial" (#152 could not locate it), and anything else that only a preview
build on a physical iPhone will show. Note that `eas.json` `preview.ios` is
`simulator: true` — it cannot be installed on a phone. Device QA on iOS today
means Expo Go plus EAS Update, or an internal-distribution device build with
registered UDIDs, or TestFlight.

## 4. Expo Go versus a Development Build — the determination

| Target | Runs today? | What it needs |
| --- | --- | --- |
| Expo Go, iOS, via EAS Update | **yes** | nothing new; it is how the iPhone opens |
| Expo Go, iOS, via `expo start` | **no** | P0-3 |
| Expo Go, Android, any path | **no** | cannot be made to work: P0-1 is native. A QA-only stopgap exists (see P0-1) and is not a fix |
| Development build (EAS `development`) | not buildable | P0-2 (`expo-dev-client`), then P0-1's patch |
| Preview build (EAS `preview`) | Android APK yes; iOS simulator only | P0-1's patch for Android; a device profile for iOS |
| Production build | not yet | everything in §12 |

So: **the app requires an Expo Development Build for Android, for boot, and
Expo Go remains usable for iOS.** Every native dependency the shell uses is in
Expo Go's `bundledNativeModules.json` at the installed version, so nothing
else forces a custom build; the patched webview is the only reason.

## 5. Dependency audit

`expo-doctor`: 4 of 21 checks fail — config schema (see below), duplicate
`react`/`react-dom` (18 at the root for the web app, 19 in `apps/mobile`; the
DOM bundle carries exactly one, 19.2.3), the directory check (blocked network
here), and five patch-version mismatches.

| Package | Category | Note |
| --- | --- | --- |
| `expo`, `expo-router`, `expo-updates`, `expo-constants`, `@expo/ui` | Outdated (patch) | doctor wants `~57.0.24 / 57.0.22 / 57.0.23 / 57.0.19 / 57.0.19`. `npx expo install --check`. Low risk |
| `react-native-webview` 13.16.1 | **Requires native patch** (P0-1) | matches Expo Go's bundled version; upstream through 14.0.1 has the same Android gap |
| `@expo/dom-webview` 57.0.1 | Should not be used as-is | no `WebChromeClient` on Android; the reason for the swap in #148 |
| `expo-web-browser`, `expo-linking`, `expo-splash-screen`, `react-native-safe-area-context`, `react-native-screens`, `expo-constants` | Safe for Expo Go | used by the shell or by expo-router |
| `react-native-reanimated` 4.5.1, `react-native-worklets` 0.10.1 | Safe for Expo Go | splash overlay only |
| `@expo/ui`, `expo-glass-effect`, `expo-symbols`, `expo-font`, `expo-device`, `expo-system-ui`, `expo-status-bar`, `react-native-gesture-handler` | Unused template leftovers | zero imports in `apps/mobile/src`. Safe in Expo Go, so harmless; prune before store submission to shrink the review surface |
| `react-native-web` 0.21 | Web-only | only needed if the Expo app itself ships a web target; the web app is Vite. Prune |
| `react` 19.2.3 / `react-dom` 19.2.3 (mobile) vs 18.3.1 (root) | Duplicate | hygiene, audited harmless in `MOBILE_AUDIT.md` §2.10 |
| `expo-dev-client` | **Missing** (P0-2) | required by the `development` profile |
| `patch-package` | To add | carries P0-1 |

`experiments.reactCompiler: true` is on. Verified in the exported DOM bundle:
React's compiler runtime is present but **no component is compiled** — the web
app's files are outside the compiler's scope. It is inert for the shell today
and will apply to the first nativized screen under `apps/mobile/src`.

## 6. Environment and API

| Name | Where set | State |
| --- | --- | --- |
| `EXPO_PUBLIC_ORIGIN` | `eas.json` env blocks (all three) | set; a local `expo start` needs `.env.local` or the badge QR encodes the webview's origin |
| `EXPO_PUBLIC_API_URL` | unset | falls back to the deployed Worker (`src/lib/http.ts:14-16`) — correct for a shipping build |
| ~~`EXPO_PUBLIC_MAPTILER_KEY`~~ | retired | tiles come from the Worker on `MAPTILER_API_KEY`; remove the variable from EAS |
| `EXPO_PUBLIC_GOOGLE_MAPS_KEY` / `MAP_ID` | unset | cannot work from `file://` (no referrer); leave unset, the app falls back by design |
| `ALLOWED_ORIGINS` (Worker) | `api/wrangler.toml:78` | four web origins; **must not gain `null`**; the Capacitor entries were reverted |

No `localhost`, `127.0.0.1` or `http://` API endpoint anywhere in the shell.
Every API call from the phone goes over the bridge (`api-bridge.ts`), where
React Native's `fetch` has no origin and no CORS. Timeouts are raced across the
bridge; 204/205/304 are handled; photo bytes cross as base64. All of it is
gated (`verify:bridge`, 28 checks) and none of it has been exercised against
the live Worker from this sandbox.

| Feature | API | iOS | Android | Root cause if failing | Fix |
| --- | --- | --- | --- | --- | --- |
| Login | `POST /api/auth/login` | [device] works | blocked by P0-1 | — | P0-1 |
| Bootstrap | `GET /api/bootstrap` | [gate] | P0-1 | — | — |
| Mutations / sync | `POST /api/mutations` | [unverified] | P0-1 | — | test hardest after P0-1 |
| Photo upload | `POST /api/photos/:id` | [unverified] | P0-1 | fixed in #148, base64 body | device test |
| Tap a house → address | `POST /api/geocode/reverse` | [unverified] | P0-1 | needs the deploy + server key | confirm `version.commit` |
| Street View | `GET /api/streetview` | [unverified] | P0-1 | needs the deploy | confirm |
| Directions line | `POST /api/directions` | [unverified] | P0-1 | needs the server Google key | — |
| Lists, team, profile, badge, onboarding | `/api/lists`, `/api/users`, `/api/me/*` | [unverified] | P0-1 | — | — |
| CSV export | — | n/a | n/a | console-only, not in the phone bundle | — |

## 7. Permissions

| Permission | Needed? | iOS | Android | Asked when | Denied handled? |
| --- | --- | --- | --- | --- | --- |
| Location (while in use) | yes — route ordering, tap-to-locate | `NSLocationWhenInUseUsageDescription` ✓ | `ACCESS_FINE/COARSE_LOCATION` ✓, prompt via `geolocationEnabled` | first geolocation call (map) | yes — `getPosition()` resolves `null`; the route still builds |
| Camera | yes — lead photos, profile photo | `NSCameraUsageDescription` ✓ | deliberately **not** declared; capture is delegated to the camera app via the file chooser (`MOBILE_AUDIT.md` §7) | on the file input | the picker simply offers the library |
| Photo library | yes | `NSPhotoLibraryUsageDescription` ✓ | not required for the chooser | on the file input | — |
| Microphone | **no** | none declared — correct | none | — | `speech.ts` uses `SpeechRecognition` only if the webview exposes it; WKWebView does not, so dictation is hidden. Verify the button is absent on a device |
| Notifications | no (none implemented) | — | — | — | `SetupStep` reports "unsupported" honestly |
| Files / downloads | no | — | — | — | CSV export is console-only |

Nothing unnecessary is requested. No background location anywhere.

## 8. Configuration review

`app.json`: name, slug, `version 0.1.0`, portrait, `scheme: allstar`, icon,
adaptive icon (generated from `brand/`, alpha rule gated), splash, iOS bundle id
and plist strings, Android package and permissions, `predictiveBackGestureEnabled: false`,
`supportsTablet: false`, `ITSAppUsesNonExemptEncryption: false`, EAS project id,
`runtimeVersion.policy: sdkVersion`, `updates.url`. **`expo-doctor` reports a
schema failure** whose detail it did not print; run `npx expo config --type
public` to surface the offending key before the first production build.

`eas.json`: three profiles, `appVersionSource: remote`, `production.autoIncrement`,
`submit.production.ios.ascAppId` present, Android `track: internal`. Gaps:
`development` needs `expo-dev-client` (P0-2); `preview.ios` is a simulator
build (§3); `runtimeVersion` on `sdkVersion` is right for Expo Go and must be
decided deliberately before the first store build, because changing it later
orphans installed builds from future updates.

## 9. Screen-by-screen test plan

To be run on a **preview build** (Android APK; an iOS device build once a
profile exists), never Expo Go — `MOBILE_AUDIT.md` §2.4 explains why Expo Go
shows faults a real build does not. Each row on both platforms.

| Area | Steps |
| --- | --- |
| Boot | cold start → sign-in screen; no Expo branding anywhere |
| Auth | login; wrong password shows the server's message; sign out; force-quit and reopen → still signed in; expired token → returned to sign-in with queued work kept |
| Onboarding | profile step (name, phone, photo from camera and from library), badge step, setup step (location prompt appears once; notifications reads "unsupported") |
| Map | opens; location prompt; blue dot; pan/pinch (pinch does not open Add-lead); tap a house → address fills (needs the deploy); Add lead; open a pin |
| Leads | add, edit, change status, add photo (camera + library), Call / Text / Email open the dialer, Messages, Mail (P1 fix first) |
| Lists | open a list; map focuses; assign/unassign a rep (console) shows on the phone after sync |
| Visit Mode | start a visit; every outcome; keyboard does not cover the note field; dictation button absent |
| Route / Navigate | route builds from current position; Navigate opens the real Maps app with the address, and Back returns to All-Star |
| Offline | airplane mode → knock three doors → reconnect → they upload; map with a downloaded territory still draws (after P1 fix + key) |
| Profile / Badge | edit and save; badge renders; QR encodes `https://allstar.letlois.com/verify/…` not a local origin; verify page opens in the in-app browser |
| Android only | hardware back inside a lead form goes back, at Today exits; no page zoom after pinching the map |
| iOS only | safe areas: nothing under the notch or home indicator on Today, Map, Pipeline |

## 10. Error handling

The web app already avoids blank pages for its own failures: sign-in
distinguishes "reached the server, browser refused the reply" from a real
outage; bulk operations report partial results honestly; the offline-maps panel
declines rather than crashing. Twenty `catch` blocks in the rep app swallow
deliberately with a comment (storage unavailable, revoke a URL, private mode) —
none logs-and-continues silently. The two blank-screen failures found here are
both at the shell boundary, where the web app never runs (P0-1) or never sees
the tap (Call/Text/Email). Phase 9 work belongs after those.

## 11. Performance

The DOM bundle is 1.0 MB of JavaScript plus 56 KB of CSS; the native bundle is
3.4 MB Hermes. `MIGRATION_PROGRESS.md` already records that each DOM screen
carries ~2 MB of web runtime and orders nativization by what a rep touches
most. Nothing measured here contradicts it. The fetch-proxy chain and duplicate
stylesheet on re-render were fixed in #148. No evidence of a new hot spot from
source; measure on a device before changing anything.

## 12. Store readiness

Apple: bundle id ✓, `ascAppId` ✓, usage strings ✓, icon and splash from
`brand/` ✓ (alpha rule gated), encryption declaration ✓, `supportsTablet: false` ✓.
**Owed:** Privacy Policy URL and a link to it in the app; in-app account
deletion (5.1.1(v)) — none exists, and `ManageUser.tsx:652` says a user cannot
delete their own account; App Privacy declarations (precise location, photos,
contacts); a device-installable iOS build profile; the `runtimeVersion` decision.

Google Play: package ✓, adaptive icon ✓, permissions minimal ✓, `track: internal`
✓. **Owed:** Play Console record and app signing; Data Safety declarations;
Privacy Policy URL; account deletion; target API level check on the first
production build.

## 13. TypeScript

Root `tsc`: **0 errors** once the workspace is installed (`npm ci` at the root
links `@allstar/core`; without it every re-export shim fails to resolve — a
fresh clone that runs `npm install` only in a subdirectory will see ~525
errors, all of them this).

`packages/core`: 0 errors.

`apps/mobile`: 48 errors in this environment — 44 `google` namespace
references in the web app's Google Maps files, 2 CSS side-effect imports, 2
PNG imports. The last four need `expo-env.d.ts`, which Expo generates on
`expo start` and which is git-ignored; the first 44 are the root's
`@types/google.maps` not being reached from `apps/mobile`'s `tsconfig`. #147
recorded the mobile typecheck clean, so the difference is environmental. Fix
by declaring `"types": ["google.maps"]` (or a `paths`/`typeRoots` entry) and by
generating `expo-env.d.ts` in CI before `tsc`. P3.

## 14. The plan

**P0 — cannot run**
1. Add `expo-dev-client`; confirm `eas build --profile development --platform android` builds. (P0-2)
2. Patch `react-native-webview` Android to provide `injectedObjectJson` at document start; extend `verify:shell` with an Android-order boot that fails on the unpatched bundle and passes on the patched one; build the dev client; boot on an Android device. (P0-1)
3. Allow the dev-server origin in `__DEV__` so `expo start` works on iOS. (P0-3)

**P1 — core functionality broken**
4. `tel:` / `sms:` / `mailto:` → `Linking.openURL`. Gate it.
5. ~~Offline tiles → IndexedDB with an app-side read~~ **done**; retiring the service worker's now-redundant tile handler is P2 housekeeping.
6. Confirm the Worker deploy (`version.commit`) so address lookup and Street View exist on the phone; set the server Google key if not set.
7. ~~Decide basemap imagery~~ **done: proxied through the Worker.** Set `MAPTILER_API_KEY` on the Worker (`MOBILE_SETUP.md` step 4).
8. An iOS device build profile (internal distribution) so iOS QA is not Expo Go.

**P2 — major mobile bugs**
9. Run the §9 checklist on both platforms on preview builds; triage what it finds. Visit Mode keyboard first.
10. `npx expo install --check`; prune the unused template dependencies; resolve the duplicate React.
11. Surface and fix the `app.json` schema complaint from `expo-doctor`.

**P3 — UX and polish**
12. Whatever §9 turns up that is not P2; the tutorial visual fault; mobile typecheck reproducibility (§13).

**P4 — stores**
13. Privacy Policy URL + in-app link; in-app account deletion (screen + endpoint); App Privacy and Data Safety declarations; Play Console record and signing; `runtimeVersion` decision; first production builds; submit nothing automatically.

---

### What changed on this branch during and after the audit

P0 is written, gated where a gate can reach it, and unproven on a device:

- `3f05cce` — `expo-dev-client` installed (P0-2).
- `dc3a09c` — the URL gate allows the dev-server origin under `__DEV__` (P0-3).
- P0-1 — `apps/mobile/patches/react-native-webview+13.16.1.patch` registers
  `injectedObjectJson` as a document-start script on Android
  (`WebViewCompat.addDocumentStartJavaScript`, behind the
  `DOCUMENT_START_SCRIPT` feature check, value quoted with
  `JSONObject.quote`), applied by `patch-package` from the workspace's
  `postinstall`. `verify:webview-patch` checks the installed module carries it
  and fails by name when the patch is dropped or `postinstall` removed. The
  Java was checked to parse (`javac`: only missing-dependency errors); it has
  not been compiled into an APK from here. **Next: `eas build --profile
  development --platform android`, install, boot, sign in, force-quit, reopen.**


- `21e73f4` — reverted the Capacitor origins added to `ALLOWED_ORIGINS`
  earlier in the week. This app does not send them; the native path is the
  bridge, and `MOBILE_SETUP.md` already said no CORS entry is needed.
- P1: `tel:`/`sms:`/`mailto:` hand off to the OS (`f504531`, `verify:handoff`),
  and offline tiles moved to IndexedDB with an app-side read (`verify:offlinemaps`
  extended and sabotage-proved both ways).
- No other code changed. This document and the repro script are the output.
