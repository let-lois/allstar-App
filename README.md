# Allstar Field

Door-to-door field sales, built for the phone.

This is **not** a desktop CRM that reflows. The primary user is a Field Rep
standing outside a house, one-handed, in sunlight, on one bar of LTE, trying to
finish a knock in under fifteen seconds. Every screen is designed for that
person first; tablet and desktop are progressive enhancements on top.

```bash
npm install
npm run dev          # http://localhost:5173
```

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

## Data layer

`lib/api.ts` is a stand-in for the backend that models real cellular latency and
can fail. Everything above it — the queue, optimistic UI, sync indicator — is
written against a real async boundary, so swapping in HTTP is a one-file change.
Seed data (`data/seed.ts`) is deterministic; nothing outside that file knows it's
synthetic.

Toggle **More → Field testing → Simulate no signal** to exercise the offline
path without leaving coverage.
