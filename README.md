# Allstar Field

Door-to-door field sales, built for the phone.

**Live:** [allstar.letlois.com](https://allstar.letlois.com)

This is **not** a desktop CRM that reflows. The primary user is a Field Rep
standing outside a house, one-handed, in sunlight, on one bar of LTE, trying to
finish a knock in under fifteen seconds. Every screen is designed for that
person first; tablet and desktop are progressive enhancements on top.

```bash
npm install
npm run dev          # http://localhost:5173
```

Deployed on Cloudflare Pages from `main` — every merge ships. Other branches
build to their own preview URL, so production is never the place you find out.

## The rule this codebase is built around

Every feature has to answer: *how does the Field Rep use this on a phone while
standing outside a property?* If something works well on desktop and is
awkward on a phone, the mobile experience gets redesigned — it does not get a
responsive breakpoint bolted on.

## Core flow

The whole product is shaped around one loop, and it costs four taps:

```
Today → Start visit → Outcome → (note / photo) → Next action → Complete → Next property
```

`No Answer` — roughly two thirds of all knocks — short-circuits the middle and
finishes in two taps.

## What's here

| Area | Notes |
| --- | --- |
| **Today** (`screens/Today.tsx`) | Operational home. Progress, next stop with distance, appointments, follow-ups, activity. |
| **Map** (`components/map/FieldMap.tsx`) | Full-bleed, touch-first, self-rendered basemap — no tile server, so it works offline and costs no bandwidth. Pinch/pan, clustering, route line, live location. |
| **Visit Mode** (`screens/VisitMode.tsx`) | Sealed three-step flow. No nav, no side trips, primary action pinned to the bottom throughout. |
| **Outcomes** (`components/visit/OutcomeGrid.tsx`) | 72–80px targets. Color *and* glyph *and* label, so it survives sunlight and colorblindness. |
| **Notes** (`components/visit/NoteComposer.tsx`) | Templates → tags → dictation → keyboard, in that order of preference. |
| **Photos** (`components/visit/PhotoStrip.tsx`) | OS camera, compressed on-device, categorized *after* the shot. |
| **Leads / Pipeline** | Windowed list, nearest-first. Pipeline is a stacked funnel on mobile — dragging kanban cards on a phone is a desktop fantasy. |
| **Offline** (`lib/sync.ts`, `lib/db.ts`) | See below. |

## Offline-first

Connectivity is assumed to be *absent*, not degraded. Every write follows the
same path:

```
write to IndexedDB  →  update React state  →  enqueue mutation
   (durable)            (instant, no spinner)   (drains when there's signal)
```

Nothing in the UI ever awaits the network. A completed visit is saved the
moment it's queued; the always-visible sync chip is what tells the rep whether
it has reached the server yet. A service worker caches the app shell so a cold
start with no connection still boots.

Verified end to end:

```bash
npm run build
npm run preview &
npm run verify:offline
```

...which asserts that a rep can complete a visit offline, kill the app, relaunch
with no connection, still see their work, and have it upload by itself on
reconnect.

## Demo data

The demo is a full company, not one rep: **five field reps** with their own
territories, routes and hit rates, so a manager view shows a real spread rather
than five identical bars. Sign-in offers one rep plus the three office roles;
the other reps exist as teammates.

Two rules govern `data/seed.ts`:

- **Deterministic** — seeded RNG, so every reload and every device shows the
  identical neighborhood. A demo that looks different on the second run is one
  you can't rehearse.
- **Time-relative** — every timestamp derives from "now", and the bundle is
  regenerated when the calendar day rolls over (`lib/demo.ts`). Without this the
  demo silently empties out overnight: today's appointments become yesterday's
  and drop off the Today screen. That failure is discovered in front of a
  prospect, so it has a gate:

```bash
npm run verify:demo
```

...which boots the app, jumps the device clock forward four days, reloads, and
asserts the route, appointments and activity are all still there.

**More → Field testing → Reset demo data** restores a pristine dataset between
pitches. It is hidden on a live account, where there is no seed to restore and
the button would only offer to delete a rep's real work.

## Office console

`/admin` is the one deliberately **desktop-first** surface. Everywhere else
mobile is the design and desktop is the enhancement; here the work — comparing
reps across a month, reassigning territories, auditing configuration — is dense,
wide, and done sitting down. On a phone it hands off to the mobile screens
rather than rendering wide tables badly.

| Section | Who | What |
| --- | --- | --- |
| Dashboard | Manager+ | KPIs vs the previous window, daily trend, open-pipeline funnel, rep table, live activity |
| Reports | Manager+ | Range and per-rep filters, volume vs contact rate, full breakdown, CSV export |
| Team | Manager+ | Roster, roles, territory, per-rep performance |
| Territories | Manager+ | Coverage table linked to a map of the patch |
| Settings | Admin | Outcomes, note templates, photo categories |
| Clients | Super Admin | Platform roll-up across accounts |

It is **lazy-loaded**: a field rep never opens it, so its tables and charts stay
out of the phone bundle entirely.

Charts follow the `dataviz` method — one axis, categorical hues in fixed order,
an ordinal ramp for ordered stages, a single hue for one measure, legends and
direct labels so identity never rests on color. The palettes in
`admin/charts/tokens.ts` were run through the validator against this app's own
chart surface; re-run it before changing a hex.

```bash
npm run verify:console
```

...asserts a field rep cannot reach the console even by URL, that a manager sees
fewer sections than an admin, and that a phone gets the handoff.

## Mobile layout audit

```bash
npm run audit:viewports
```

Walks the field-rep flow at 320 / 375 / 390 / 430 / 768 / 1024 px and fails on
horizontal overflow or any interactive element under 44px. Screenshots land in
`viewport-audit/`. This is a gate, not a nicety — it has already caught a dead
Complete button and a tap target that was unreachable behind the zoom control.

## Responsive strategy

- **Phone** — the design. Bottom nav, bottom sheets, bottom-anchored actions.
  Nothing important lives in the top-right corner.
- **Tablet (`md`)** — map gains a stop list beside it instead of just getting
  taller.
- **Desktop (`lg`)** — persistent side rail; Leads becomes master-detail.
  Single-pane screens stop stretching at a readable measure rather than growing
  900px-wide buttons.

Office roles (Manager, Client Admin, Super Admin) get a read-and-react overview
on mobile — "is today going the way it should?" — with the full console
(user management, territories, imports, reporting) reserved for desktop.

## Sign-in: two modes

The login screen has two doors, and the split is deliberate rather than a flag.

| | Demo | Live |
|---|---|---|
| Account | none | email + password against the API |
| Data | seeded (`data/seed.ts`) | the account's own tenant, via `/api/bootstrap` |
| Outbox drains to | a latency simulator | `/api/mutations` |
| Reset demo data | offered | hidden — it would only delete real work |

The demo stays first-class because it's what gets shown to a prospect on hotel
wifi: a pitch that breaks when the backend does isn't a pitch. The mode is stored
next to the data it describes (`lib/session.ts`), so a reload can't land in a
state where the app reads demo properties while pushing them to a real tenant.

**Signing in wipes whatever the last account cached** — field phones get shared,
and a rep's leads are their company's data. The outbox is the one thing that
survives: it holds work that hasn't reached the server yet, and deleting it
because someone signed out would destroy a morning's knocks.

That's also what happens when a token expires mid-shift. The discovery almost
always lands inside a background drain with no screen attached, so `lib/session.ts`
raises it as an event, the store drops to the login screen, and the queued rows
keep their place and their retry budget — they go up when the rep signs back in.

```bash
npm run verify:login
```

...mocks the API at the network layer and asserts all of it: a bad password shows
the server's reason, an unreachable server is reported as a *connection* problem
rather than a bad password, the demo works with every API call aborted, a live
account sees only its own tenant's addresses, an expired session preserves the
outbox, and signing out leaves nothing on the device.

## Data layer

`lib/http.ts` is the API client — thin on purpose, because the app reads from
IndexedDB and only touches the network at three moments: signing in, refreshing
the cache, and draining the outbox. `lib/api.ts` sits above it and dispatches to
either real HTTP or the demo's latency simulator, so both modes exercise the same
failure paths.

The outbox sends **batches** (`BATCH_SIZE`, capped at 200 server-side). The shape
of the problem is bursty: a rep works a street with no signal and queues thirty
writes the moment a bar appears. One request beats thirty round trips where any
single drop restarts the tail. The server's per-mutation verdict is authoritative,
and `duplicate` counts as success — it means a previous attempt landed and what
we lost was the response.

Seed data (`data/seed.ts`) is deterministic; nothing outside that file and
`lib/demo.ts` knows it's synthetic.

`VITE_API_URL` overrides the API origin at build time (see `.env.example`);
unset, the client uses the deployed Worker.

Toggle **More → Field testing → Simulate no signal** to exercise the offline
path without leaving coverage.
