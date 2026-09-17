# `@allstar/core`

The part of All-Star that is true regardless of what is underneath it.

A door is closed at the same hour in the same timezone whether the screen
asking is Safari, an admin console on a desktop, or an iPhone app. This package
is the code that answers questions like that — and nothing else.

## The rule

**It compiles with no platform library at all.**

```jsonc
// tsconfig.json
"lib": ["ES2020"],   // not DOM
"types": [],         // not @types/node either
```

That single pair of settings is the whole design. Reach for `document`,
`window`, `localStorage`, `IndexedDB` or React in here and it does not
compile — so portability is checked by `tsc`, on every run, rather than
remembered by whoever is reviewing. `npm run verify:core` is that check, and it
is part of `verify:all`.

The two host globals that *are* used — `crypto.randomUUID` and `TextDecoder` —
are declared in `src/globals.d.ts` with the reason, and both call sites already
handle their absence.

## What is in it

20 modules, 3,589 lines:

- **Domain** — `types`, `outcomes`, `roles`, `settings`
- **The day** — `day`, `format`
- **Leads** — `leadFilter`, `leadLists`, `contact`, `address`
- **Geography** — `geo` (spherical distance, bearing, Web Mercator), `route`, `basemap`
- **Data in and out** — `csv`, `qr`, `id`
- **Presentation-adjacent but platform-free** — `glyphs`, `leaderboard`, `seed`, `walkthrough`

## What is deliberately *not* in it

Anything that asks the platform a question, even when it looks like logic:

| Stayed behind | Because |
| --- | --- |
| `db.ts` | IndexedDB. Becomes `expo-sqlite` on native — the adapter boundary. |
| `http.ts`, `api.ts`, `sync.ts` | Online/offline detection, `Blob`, `FileReader`. |
| `geo.ts`'s second half | `navigator.geolocation`, and which maps app to hand an address to. |
| `photos.ts`, `media.ts`, `speech.ts` | Camera, canvas, the Web Speech API. |
| `theme.ts`, `tiles.ts` | `localStorage`. |
| `install.ts`, `webview.ts`, `haptics.ts`, `badge.ts` | User-agent sniffing and PWA install prompts. |

`geo.ts` is the only file that was split rather than moved or left. Everything
else went whole.

## Using it

```ts
import { distanceMiles } from '@allstar/core/geo'
import type { Property } from '@allstar/core/types'
```

Deep imports, one module at a time. `@allstar/core` on its own re-exports
everything and exists for convenience, not for the web app to use.

Published as TypeScript source with no build step — Vite, Metro and Node's own
type stripping all read `.ts` directly, and a build step here would be one more
thing to explain.

## The shims

`src/lib/*` and `src/data/*` in the web app are one-line re-exports pointing
here, so the 122 files that import them did not all have to change in the
commit that moved them. They are scaffolding: call sites move to
`@allstar/core/...` as their screens are touched, and the last one to move
deletes the shim.
