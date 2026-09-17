# Web → native: the worklist

**Status: core extracted, native shell scaffolded. No screen nativized yet.**

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

### What is not started

- The DOM-component shell — the day-one milestone, where the existing web UI
  runs inside the native container.
- Any native screen. `index.tsx` is a checkpoint, not Today.
- `expo-sqlite` behind the `db.ts` boundary.
- App Store Connect and Play Console records. `eas.json` exists with
  development, preview and production profiles; `submit.production.ios` still
  needs `ascAppId`, which only exists once the App Store Connect record does.
- The GitHub link, which is gated on one successful `eas build` from a machine.

### The one thing to get right at setup

The mobile app will live at `apps/mobile`, not the repo root, so the Expo
project's **Base directory** must be set to `apps/mobile` in its GitHub
settings before a build from GitHub will find anything. This is the same
mistake that cost the help centre its first two Cloudflare builds, in a
different dashboard.
