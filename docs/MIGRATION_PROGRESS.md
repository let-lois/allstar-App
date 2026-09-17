# Web → native: the worklist

**Status: the web app runs inside the native app. No screen nativized yet.**

This is the durable worklist for turning the All-Star web app into an iOS and
Android app, kept in the repo so it survives a conversation. It follows Expo's
own [web-to-native](https://expo.dev/blog/from-web-to-native-with-react) order:
stand up a native shell, run the existing web UI inside it on day one, then
replace screens with native ones in the order the field actually feels.

A web React app does not convert to native — there is no transpiler. It
migrates, screen by screen, and every step has to leave something shippable
behind.

---

## 1. The two cuts

### Backend: stays where it is

The Cloudflare Worker API over D1 and R2 keeps running exactly as it does now,
and the native app becomes one more HTTP client against it. Nothing moves to
EAS Hosting. The Worker is live, the web app depends on it, and a migration
that changes the client *and* the server at once has no safe half.

### Screens: bucketed below

Every route in `src/App.tsx`, bucketed by how it should land:

| Bucket | Meaning |
| --- | --- |
| **port-as-is** | Ships inside a DOM webview on day one and may stay there for a long time. |
| **nativize-now** | Hot, or needs something a webview cannot do well: gestures, a real list, the camera, background position. |
| **nativize-later** | Should end up native; nothing breaks if it waits. |
| **hybrid** | Native shell around a web sub-tree. |
| **web-only** | Never ships in the mobile app at all. |

---

## 2. The rep app

Ordered by what a rep touches most, which is the order to nativize in.

| Screen | Lines | Bucket | Why |
| --- | --- | --- | --- |
| `Today.tsx` | 576 | **nativize-now** | First screen every morning, opened cold on cellular. Cold-start time is the whole impression. |
| `VisitMode.tsx` | 503 | **nativize-now** | The four taps at a door. Needs the native keyboard, real dictation and haptics; a webview keyboard is the single worst thing about the current app on a phone. |
| `MapScreen.tsx` | 1003 | **nativize-now** | Biggest single job. Google Maps JS + `@googlemaps/markerclusterer` has no webview future — this becomes `react-native-maps` with native clustering. |
| `Leads.tsx` | 333 | **nativize-now** | A long scrolling list with swipe actions. Needs FlashList and a real gesture handler; both are bad in a webview. |
| `RouteScreen.tsx` | 198 | **nativize-now** | Travels with Today and the map. |
| `Navigate.tsx` | 417 | **nativize-now** | Hands off to Apple/Google Maps. The seam already exists — `navigationUrl()` stayed in `src/lib/geo.ts` when the maths moved to core. |
| `PropertyDetail.tsx` | 357 | **nativize-now** | Reached from every other rep screen. |
| `NewLead.tsx` | 57 | **nativize-now** | Adding a lead at the door — needs device position, so it follows the map. |
| `Login.tsx` | 498 | **nativize-now** | First run, and the session token wants the native keychain rather than `localStorage`. |
| `onboarding/` | 1022 | **hybrid** | `ProfileStep` needs the camera and goes native early. The other four steps are forms and can sit in the webview. |
| `StreetScreen.tsx` | 338 | nativize-later | |
| `MyBadge.tsx` | 136 | nativize-later | QR generation is already portable — `qr.ts` is in core. |
| `VerifyBadge.tsx` | 124 | nativize-later | Scanning wants the native camera eventually. |
| `Lists.tsx` / `ListDetail.tsx` | 398 | port-as-is | |
| `Pipeline.tsx` | 172 | port-as-is | |
| `Standings.tsx` | 287 | port-as-is | |
| `Team.tsx` / `RepDetail.tsx` | 492 | port-as-is | |
| `ScheduleNew.tsx` | 230 | port-as-is | |
| `More.tsx` | 520 | port-as-is | A settings list. Cheap to nativize later with `@expo/ui`. |
| `MyProfile.tsx` | 128 | port-as-is | |
| `Overview.tsx` | 397 | port-as-is | Manager's version of Today. |

**Each DOM screen carries roughly 2 MB of web runtime**, which is the reason
"ship everything as DOM and stop" is not the plan.

## 3. The admin console — web-only

`src/admin/` — 8,575 lines across 10 routes — never enters the mobile app. It
is desktop software: wide tables, a lasso tool for drawing territories, a CSV
importer. The help centre already documents it as desktop-only and films it on
a desktop. It stays in the web app and nothing about this migration touches it.

## 4. The hard part nobody sees

Storage. The app is offline-first: IndexedDB → React state → a sync queue.
`src/lib/db.ts` (370 lines, `idb`) is the single adapter boundary, and on
native it becomes `expo-sqlite`. Everything that reads or writes goes through
it, which is the good news; it is also the one piece where a mistake loses a
rep's day of knocks, so it gets written against the existing gates
(`verify:offline`, `verify:persistence`) before any screen
depends on it.

---

## 5. Step 1 — done

`packages/core` exists: 20 modules plus a barrel, 3,589 lines, compiled with
`"lib": ["ES2020"]` and `"types": []` — no DOM, no Node, no React. The
compiler, not a convention, is what keeps it portable, and `npm run
verify:core` is the gate.

`geo.ts` split at the one real seam: spherical maths and Web Mercator went to
core, `navigationUrl()` and the geolocation wrapper stayed behind.

The web app's `src/lib/*` and `src/data/*` are re-export shims, so all 122
importing files are untouched and the built bundle is byte-identical to the
commit before. Call sites move to `@allstar/core/...` as their screens get
touched.

## 6. Step 2 — done

`apps/mobile` exists: Expo SDK 57, React Native 0.86, Expo Router, React 19.
It is a workspace member (`@allstar/mobile`) alongside `packages/core`, and the
root `package.json` now lists `apps/*` and `packages/*`.

Wired to the real Expo project:

| | |
| --- | --- |
| owner | `let-lois` (organization) |
| slug | `all-star-app` |
| projectId | `497739ce-76e6-420a-b80e-308126e25f35` |
| bundle id / package | `com.allstarhomesolutions.allstar` |

No `metro.config.js`. Expo has configured Metro for monorepos automatically
since SDK 52, and the guide is explicit that `watchFolders`,
`resolver.nodeModulesPath`, `resolver.extraNodeModules` and
`resolver.disableHierarchicalLookup` should be *absent* rather than set.

`src/app/index.tsx` is a checkpoint screen, not a design: it reads `OUTCOMES`,
`OUTCOME_TO_STATUS`, `STATUS_LABEL` and `distanceMiles` from `@allstar/core`
and renders them. `npx expo export --platform ios` produces a 3.5 MB Hermes
bundle containing those strings, which is the proof that the shared package
crosses the boundary at bundle time and not merely at typecheck time.

React 19 (mobile) and React 18 (web) coexist: npm nests 19 under
`apps/mobile/node_modules` and leaves 18.3.1 hoisted for the web app. The web
bundle is byte-identical to the commit before either change.

## 7. Step 3 — done: the DOM shell

The day-one milestone. `apps/mobile/src/components/allstar-web.tsx` carries
`'use dom'`, imports the web app's own `App` and `index.css`, and Metro bundles
the result as web code for a webview. `npx expo export --platform ios`
produces:

| | |
| --- | --- |
| native bundle | 3.4 MB Hermes bytecode |
| DOM bundle | 1.0 MB JavaScript, 328 modules |
| DOM stylesheet | 56 KB — Tailwind compiled, 532 utility classes |

Verified by inspecting the output, not inferred: the rep app's strings are
present (`Today`, `Knock`, `No Answer`, `Do Not Contact`, `Leads`), the offline
storage layer is present (`indexedDB`, `openDB`, `objectStore`), and every
admin marker is absent.

**IndexedDB genuinely works**, because a webview has a real one. That is the
reason this is a DOM component rather than a `WebView` pointed at
support.letlois.com: an offline-first app whose storage is a remote page is not
offline-first, and a rep in a basement is the case the app exists for.

Three deliberate differences from the web app's `src/main.tsx`:

1. **`MemoryRouter`, not `BrowserRouter`** — there is no address bar in a
   webview and no server to ask for a path.
2. **No service worker** — it caches the app shell for an offline cold start on
   the web. The native bundle is already on the device.
3. **No install prompt** — nothing to install inside an app from the App Store.

### What it cost the web app

Three changes, each measured:

- **`import.meta.env` → `process.env.EXPO_PUBLIC_*`** at seven sites. Metro
  cannot parse `import.meta` at all, so a module using it fails to build rather
  than misbehave. `vite.config.ts` now substitutes the same `VITE_*` names via
  `define`. **An unset value becomes `undefined`, not `''`**, so the optional
  chain short-circuits and the expression still folds at build time — without
  that, an unconfigured build stopped shedding `GoogleFieldMap`, `supercluster`,
  `kdbush` and `fast-equals`, 45 KB a rep would download and never run. Routing
  the values through a shared module lost the same 45 KB, because neither
  bundler folds across a module boundary. Final result: **byte-identical
  bundles, with and without a key.**
- **`src/adminRoutes.tsx` extracted from `App.tsx`.** Metro follows a dynamic
  `import()` into the bundle instead of leaving it to be fetched, so the eleven
  lazy console imports would have put all 8,575 lines of desktop console on the
  phone — and `expo export` failed outright on the shared chunk they produced.
  `apps/mobile/metro.config.js` swaps the module for a stub that renders
  nothing. The web build is unchanged: 12 admin chunks, vendor byte-identical.
- **One copy of `@types/react`, at 19.** Two copies meant the web app's files
  were checked against React 18's `ReactNode` while their JSX came from 19's.
  Cost: two `JSX.Element` references became `React.JSX.Element`, which React
  19's types require. The web app still *runs* React 18.

### What is still unproven

That it bundles is proved. That it *renders correctly* is not — that needs a
phone, and there is no simulator in the environment this was built in. Run
`npx expo start` in `apps/mobile` and open it in Expo Go.

### What is not started

- Any native screen. `index.tsx` is a checkpoint, not Today.
- `expo-sqlite` behind the `db.ts` boundary.
- App Store Connect and Play Console records. `eas.json` exists with
  development, preview and production profiles; `submit.production.ios` still
  needs `ascAppId`, which only exists once the App Store Connect record does.
- The GitHub link, which is gated on one successful `eas build` from a machine.

### The badge QR, which would have been wrong and looked right

`EXPO_PUBLIC_ORIGIN` is set to `https://allstar.letlois.com` in every build
profile's `env` block in `apps/mobile/eas.json` — committed configuration,
since the repo deliberately keeps real `.env` values out of the tree. A local
`expo start` needs it in `.env.local`; `.env.example` says so. Every team member badge carries a QR code built from
`window.location.origin`, and inside the DOM shell that is the webview's local
origin — so the code would be one no homeowner's camera can open, with nothing
on screen looking wrong. No gate covers it.

`src/lib/badge.ts` was written for exactly this case on `main` before the shell
existed. The value is not a guess: it is the origin the API already
hard-defaults to for invite join links (`APP_URL`), and a badge and an invite
email should point at the same place.

### The one thing to get right at setup

The mobile app will live at `apps/mobile`, not the repo root, so the Expo
project's **Base directory** must be set to `apps/mobile` in its GitHub
settings before a build from GitHub will find anything. This is the same
mistake that cost the help centre its first two Cloudflare builds, in a
different dashboard.
