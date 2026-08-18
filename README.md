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

## Lead import

A tenant starts empty, and a route, a map and a planned day mean nothing without
addresses. **Console → Import leads** takes the file a company already has — a
vendor list, a county export, a manager's spreadsheet — and turns it into
properties a rep can knock.

Three decisions worth knowing:

**Ids are derived from the address**, not minted. A property's id is a hash of
`(tenant, normalised address)`, which makes a re-import idempotent by
construction rather than by a ledger someone has to remember to consult. Imports
*do* get re-run — a connection drops, a vendor sends a refreshed file, a manager
isn't sure the first upload worked — so "just do it again" has to be the correct
answer. The normalisation folds case, punctuation and street-type spelling, so
`1420 Cedar Bend Dr.`, `1420 CEDAR BEND DRIVE` and `1420 Cedar Bend Dr` are one
house rather than three doors on three reps' maps.

**A re-import refreshes the list's facts and never the field's work.** Status,
last outcome, visit history and next action belong to the rep; city, ZIP,
valuation and square footage belong to the spreadsheet. A refreshed vendor file
resetting a lead that was sold last week is silent, expensive, and ends with a
customer being knocked twice — so it has a gate (`smoke:import`) that sells a
lead, re-imports the identical file, and asserts the sale survived.

**Nothing is written until the operator has seen what will be written.** The
column mapping is auto-guessed and then *shown*; the preview is real; geocoding
runs before the write. An import is the one action in the console that's tedious
to undo, and a silently mis-mapped latitude column drops a Texas territory into
the Indian Ocean.

Geocoding uses the **US Census Bureau's geocoder** — free, no API key, no billing
account. It's US-only and matches road centrelines rather than rooftops, which is
right for walking a street and wrong for a rural parcel; swapping in Google or
Mapbox later is `api/src/geocode.ts` alone. Rows that can't be placed are held
back rather than imported at 0,0, because a property with no coordinates is
invisible on the screen the whole product is built around.

```bash
npm run verify:csv        # the parser: quoted commas, embedded newlines, BOM, CRLF
npm run verify:import     # the wizard: messy headers, held-back rows, demo can't write
cd api && npm run verify:geocode    # response parsing and the dedupe key
cd api && npm run smoke:import      # end to end against D1
```

The geocoder itself is the one thing no local test covers — it's a third-party
service reachable only from the deployed Worker. `GET /api/selftest/geocode` on
the deployment geocodes a known address and asserts the coordinates land where
that address actually is, so a changed response format or a swapped coordinate
pair shows up there rather than as a territory at latitude zero.

### A test list

`fixtures/test-leads-austin.csv` is 50 leads across 7 streets, generated by
`npm run leads:sample -- <count>`. Everything about the people is invented, and
specifically so:

- **Phones are all `555-01XX`**, the range reserved for fiction. A rep testing
  the app will tap "Call" — that must never dial a stranger.
- **Emails are on `example.com`**, reserved by RFC 2606 for exactly this.
- Names are common first and last names paired at random.

The addresses use a **numbered grid** — W 39th through W 45th Street in Austin's
Hyde Park — and the file carries **coordinates**.

Both of those are corrections. The first version guessed at Round Rock street
names from memory and shipped them without coordinates, leaving the geocoder to
resolve them: 32 of 50 didn't exist and were unimportable. Inventing street names
is not something that can be done carefully, so this version doesn't. A numbered
grid is structural rather than remembered, and shipping coordinates means the
import doesn't depend on a lookup succeeding at all.

The headers are written the way a real export writes them — `Property Address`,
`Zip Code`, `Est. Value`, `Sq Ft` — none matching the internal field names, so
the file doubles as a live test of the wizard's automatic column mapping.

To check an address resolves before uploading a list without coordinates:

```
/api/selftest/geocode?address=700+W+41st+St&city=Austin&state=TX&zip=78751
```

## Planning a day

Imported leads are a list, not a plan. **Today → Plan N doors** turns a rep's
assigned leads into a walking order, and it runs entirely on the phone — route
building happens in a truck at 6am, often with no signal, and must never wait on
a server.

The ordering is nearest-neighbour from wherever the rep is standing. That's a
deliberate choice, not a shortcut: the optimal tour is the travelling-salesman
problem, and nearest-neighbour lands within roughly a quarter of optimal while
producing a route a human recognises as sensible — finish this street, then the
next one. A mathematically shorter route that criss-crosses a neighbourhood gets
abandoned by lunchtime, so the better tour on paper is the worse tour in the
field.

Doors already knocked today are excluded (knocking twice annoys the prospect and
inflates the rep's own numbers), as are closed leads and anything without
coordinates. The route id is derived from rep + day, so tapping "plan" twice
replaces today's route rather than leaving two of them fighting over the screen.

```bash
npm run verify:route      # ordering, exclusions, size caps, naming
npm run verify:firstday   # the whole first morning, in a browser
```

### Three bugs this found

`verify:firstday` exists because a live account behaves nothing like the demo,
where a route is always seeded. All three of these were invisible in the demo and
none of them threw:

1. **Today congratulated a rep who had done nothing.** With leads assigned and no
   route, it fell through to "Route complete — 0 doors knocked today. Nice work."
   and offered no way to start.

2. **The map showed "0 properties" while Leads showed five.** The default filter
   is "My route", which matches nothing when there is no route.

3. **A cold start deleted queued work.** This is the serious one. `initSync()`
   drains the outbox on start-up, and it ran *before* the session was read — so
   `isDemo()` answered "yes", the demo simulator marked every queued mutation
   applied, and the queue deleted it. On a live account: a rep queues a morning of
   visits with no signal, closes the app, reopens it, and the work is gone.
   Never sent, no error, no trace. The offline suite couldn't catch it because
   that suite runs in demo mode, where answering "demo" is correct.

   Fixed twice over — the session is now read before the outbox starts, and
   `pushMutations` refuses to send at all while the session is unknown, so a
   future reordering can't bring it back.

A related hole closed at the same time: a bootstrap refresh replaced local rows
wholesale, which deleted anything created on the phone but not yet synced —
routes, tasks, appointments, field-added leads. The refresh now merges rather
than replaces whenever the outbox holds work, sampled both before and after the
request so a queue that drains mid-flight can't slip through the gap.

## Adding people

**Console → Team → Invite user.** Name, email, role; the server creates a
pending account and returns a one-time link. The invited person opens it and sets
their own password — nobody else ever sees or sets it.

The thing this screen is careful about: **it never says an email was sent**,
because none is. There's no mail service connected, so the flow ends where it
actually ends — with a link on screen, a copy button, and a plain instruction to
send it yourself. An admin who believes a rep was notified finds out a week later
that nobody got anything, and a product that quietly overstates what it did is
worse than one that does less.

Invited users show as **Invite pending** rather than Active or Deactivated. Those
three states look identical behind a single boolean, and an admin chasing a rep
who never got their link needs to tell them apart.

```bash
npm run verify:invite
```

...asserts the whole flow including the part that matters: the screen says no
email went out, never claims one did, shows the full link, copies it, and marks
the new person pending. Plus that the demo makes no invite request at all and
says why.

## Handing out the work

**Console → Territories → Assigned rep.** Changing it moves every lead in that
patch to that person, and it works on the **Unassigned** bucket too — after a
plain import that's all of them, so without it a first import would be
unassignable except by re-importing, which is a workaround dressed as a feature.

Bulk by territory rather than per property, because that's the unit the work is
organised in: a manager hands someone a patch, not four hundred individual doors,
and reassigning a rep who quits has to be one action. A territory only claims an
owner when every lead in it agrees; split patches read **Mixed**.

Scoping is enforced server-side, not just filtered in the client: unassign a rep
and their next bootstrap stops returning those properties.

## Managing an account

**Console → Team → Manage.** Reset a password, remove someone, or delete the
account. Three operations, and the distinction between them is the whole design:

| | What happens | When |
|---|---|---|
| **Set a password** | They sign in with it; **every session they hold dies** | A phone went missing |
| **Reset link** | They choose their own; the admin never sees it | Normal password trouble |
| **Remove from team** | Can't sign in; sessions end now; **work stays** | Someone left |
| **Delete permanently** | Row gone, and everything keyed on it cascades | Almost never |

Deleting a user is genuinely destructive: `visits`, `notes`, `activity`, `tasks`,
`routes` and `daily_stats` all cascade. That isn't a login, it's the company's
reporting history with a hole in it — a rep who worked eight months takes eight
months of doors-per-day with them. So the panel counts the records first and
requires the person's name to be typed. The numbers are the informed half of
informed consent; "are you sure?" isn't. Leads are `ON DELETE SET NULL`, so they
survive and fall back to Unassigned.

Two rules keep a company from locking itself out: **an admin cannot act on their
own account** (they can still change their own password), and **the last
administrator cannot be removed**. The second is expressed as a condition inside
the write rather than a check before it — two admins deactivating each other at
the same moment would both pass a separate check, since each still sees the other
as active.

Setting a password revokes every session for that user, including the admin's own
if they changed their own. That's the point of a reset after a phone goes missing:
the old credential has to stop working everywhere, not eventually.

```bash
cd api && npm run smoke:users   # 28 assertions, mostly about what is refused
npm run verify:invite           # the panel, including the delete confirmation
```

Role changes are still read-only.

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
