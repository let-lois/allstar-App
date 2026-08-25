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

## Schema changes apply themselves

The Worker runs its own migrations on the first request after a deploy
(`api/src/migrate.ts`). There is no console step, and no SQL to paste.

That's a correctness decision more than a convenience one. The manual version is
easy to forget, easy to run against the wrong database, and impossible for anyone
who isn't the account owner — and its failure mode is silent: the deploy
succeeds, the API answers, and one feature quietly doesn't work because a table
isn't there.

Three rules keep it safe. **Additive only** — nothing drops a column or a table,
because a migration that destroys data on deploy destroys data on rollback.
**Claimed before applied** — the ledger insert is the lock, so two isolates
starting at once can't both run the same migration. **Never a total outage** — a
failed migration is reported through `/api/health` rather than taking the API
down, and the claim is released so the next deploy retries instead of skipping it.

```bash
cd api && npm run smoke:migrate
```

...runs against a database carrying the *old* schema and asserts the Worker
brings it up to date by itself — checked through behaviour (does rate limiting
bite, is the audit log readable) rather than by inspecting the schema, because a
table that exists but isn't reachable from the code is no better than a missing
one.

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

## The first-run tour

A rep who has never opened the app gets a six-step tour of it: a spotlight on a
real control, a card saying what it is for, Next / Back / Skip.

The steps point at **live elements** via `data-tour` attributes, not at
screenshots. A tutorial made of pictures teaches someone what the app looked
like when the pictures were taken; these holes are cut around whatever is on
screen at the moment they are shown, so the tour cannot quietly go out of date.
If an anchor is missing — no route planned, so no next stop — that step is
dropped and the counter renumbers, rather than spotlighting empty space.

It **walks the app** rather than one screen of it: each step names the route it
lives on and the tour navigates there before spotlighting anything. That is the
only honest way to explain a five-tab product — a tour that stays on the home
screen and describes the other four is a list of promises. It is mounted in the
app shell for exactly that reason; anything rendered inside a route unmounts
itself the moment it navigates.

Two lists, because two jobs:

- **Field rep — 22 steps.** The day, the next door, navigate, the knock, the
  offline promise, appointments, follow-ups, the map and its filters and search,
  leads and how to sort them, the route, the pipeline, the standings, the
  quick-add button, the profile photo, what is cached, and offline maps.
- **Office — 21 steps.** The company's day, who is out, the team screen, then
  the same map/leads/pipeline/standings the reps get, and then the console:
  its tabs, the dashboard, people, assigning work, territories and import.

The overlap is shared rather than written twice, so a change to how the map is
explained reaches everyone.

The overlay swallows taps. A tour where the highlighted control still works
sounds friendlier and is not — the first thing anyone does is press it, the
screen changes underneath, and the tour is left pointing at whatever now
occupies those coordinates.

Skipping counts as seen. Someone who skipped made a decision, and showing it
again tomorrow is the app overruling them — so **More** carries "Show the
tutorial again", first in the Go to list, because people skip on the first
morning standing next to a van and want it back later.

That row is for everyone. It was gated to field reps for one release, from back
when the rep tour was the only one that existed — which left the people with the
most screens to learn as the only ones who could not ask to see them again.

```bash
npm run verify:tour
```

Proved by breaking it three ways. One assertion — *the card is fully on screen* —
exists because of a real bug: the card centred itself with a translate and then
ran an entrance animation that also set `transform` with fill-mode `both`. The
centring lost, the card sat half off the right edge of a 390px phone, and Next
could not be tapped at all. It looked perfectly fine in a screenshot of the
spotlight.

Every gate signs in on a fresh context, which is by definition a first run, so
they call `dismissTour()` from `scripts/lib/tour.mjs` — the same Skip a person
taps. The alternative was teaching the app to recognise automation, which would
mean the thing being tested is not the thing that ships.

Two more bugs the walk turned up once the tour spanned screens. A full-bleed
anchor — the map is the whole viewport — has no above and no below, and the card
was placed 866px down an 844px phone with Next unreachable; the tour stopped
dead on step 9 of 22, so the card's position is now a preference and the clamp
into the viewport is the rule. And moving the mount into the shell silently
broke "Show the tutorial again": the shell reads the seen-flag once, so clearing
it from More changed nothing until the request became an explicit signal.

## Profile photos

A rep taps their own avatar on **More**, picks a photo, and it is theirs. Camera
or library — `capture` is deliberately not set, because most people already have
the photo they want and forcing the selfie camera takes the library away.

The photo is centre-cropped square and re-encoded to **256×256**, which is four
times the largest place it is ever drawn and about 20KB. That number is the
reason this does not reuse the property-photo path: a 1600px portrait would be
~180KB of one person's face, downloaded by every teammate on the roster.

Stored as a data URL rather than a key into R2, and that is a deliberate
exception rather than a preference:

- An avatar is **one small row per person that every device wants offline**. A
  rep opening the team list in a basement gets faces or grey circles, and grey
  circles would mean the network is the reason they can't see who's who.
- A property photo is **dozens of multi-megabyte blobs a day that one screen
  ever opens**. Those go to R2 — see *Property photos*, below.

Different shapes, different homes. Revisit if this grows a per-client asset
store.

Local first, like every other write: on disk and on screen before the network is
consulted, with `user.avatar` riding the outbox. Demo mode stores locally and
queues nothing — there is no account behind a demo user, and a mutation that can
never be accepted would sit in the outbox forever, in a number a prospect can
read off the More screen.

Server-side the mutation is **self-only**. The payload carries a `userId` and it
is checked rather than trusted; without that, any signed-in rep could set an
admin's face by editing one field of a queued mutation. Office roles get no
exception — nobody has asked to set someone else's photo, and a role that can
rewrite a colleague's identity should be designed, not inherited from a missing
check. The body is also bounded and pattern-matched to an image data URL, so the
users table cannot become a place to store something else.

```bash
npm run verify:avatar
```

Sixteen assertions over the real flow. One of them exists because of a bug this
found: caching your own roster entry in the `team` store to remember your face
is the obvious implementation, and it **destroys the roster**. A field rep's
`team` store is empty — they get the names-only roster off bootstrap, and
`loadLocal` only reaches for it when the store has nothing in it. One row is
enough to stop that, so the next load showed a team of exactly one person. The
board went from eight names to one, which is a bug this app has had before.

## Property photos

A roof shot is the one thing a rep produces that is too big to ride the mutation
queue. That queue batches forty writes into a single request that has to succeed
as a unit; dropping a 200KB image into it means one slow upload on one bar of
signal can cost a rep a morning of knocks. So the bytes travel on their own.

The path is two hops, deliberately:

1. `photo.create` goes up with everything else — id, property, category, size,
   where the rep was standing. That row is what proves the photo belongs to a
   property in this tenant.
2. The JPEG is `POST`ed to `/api/photos/:id` and lands in R2 under
   `client/property/photo.jpg`.

The order is enforced by the server, not assumed by the client: bytes for a
photo it has no row for are refused, because there is nothing to authorize
against. The queue reads that refusal as *not yet* rather than as a failure and
comes back after the outbox drains.

`lib/photos.ts` is the queue, and the photos **are** the queue — `Photo.pending`
is the only state. A second store listing what to send could disagree with the
photos themselves, and the failure mode of that disagreement is a rep whose sync
chip never goes green with nothing to point at. One at a time, oldest first,
with the same eight-attempt budget and backoff as the outbox.

### When there is nowhere to put them

The binding is live in `api/wrangler.toml` and the `allstar-photos` bucket
exists, but the Worker still treats R2 as **optional** — a fork, a second
environment, or a customer's own account before someone adds a payment method
has no bucket, and `wrangler deploy` refuses to deploy a binding to a bucket
that isn't there. A deployment without it answers `503 no_photo_storage` rather
than accepting bytes it would drop.

That refusal is a fact about the server, not about the photo, so it is recorded
on every photo waiting and the queue stops asking. The rep is told *kept on this
phone* — not "failed", because nothing failed and there is nothing they could do
about it if it had. **More → Upload queue** does not count those photos as
outstanding.

To turn it on in a new account: create an `allstar-photos` bucket — exactly that
name — and deploy. `/api/health` reports `r2` either way, which is the fastest
way to tell which kind of deployment you are looking at.

Photos already marked local-only recover on their own. The first drain of each
app launch re-asks the server once when there is nothing else owed, and the
first upload that lands puts every remaining local-only photo back in the queue,
because a photo marked local on the strength of a refusal that no longer happens
is simply wrong. Once per launch and no more — on a deployment where the answer
really is no, re-asking every drain would be a guaranteed 503 every few seconds
forever.

That re-ask is the whole reason those photos are not stranded, and it is easy to
leave out: a local-only photo is not owed, so it is not in the queue, not in the
count, and there is no failure for anyone to retry. Turning storage on would
leave everything shot before the deploy on the phone permanently, and the only
symptom would be a rep saying the office never got their roof shots.

```bash
npm run verify:photos        # the queue, in a browser
cd api && npm run smoke:photos   # the round trip, against a real Worker
```

The smoke test starts its own Worker, because it has to run the same code under
two configurations and only one of them is what `wrangler.toml` says. It runs
the real binding against local R2, then generates a config with the binding
removed and starts the Worker again — the only way to reach the refusal path,
which is what every deployment without a bucket does.

Two things this does **not** do yet. Photos are never fetched *back*: bootstrap
returns no photo rows, so a manager's phone cannot see what a rep shot, and a
replaced handset starts empty. And the local copy is never evicted — forty
photos a day at ~200KB is ~8MB a day with nothing pruning it. The order matters:
eviction is only safe once a photo can be re-fetched on a device that never had
it, so the download path comes first.

## The theme

The app runs on a near-black ground. It is not a dark *mode* — there is no
toggle and no light variant to keep in step — it is the theme, and the login
screen it grew out of was the only part of the product already wearing it.

Colour lives in two places, and the split is the part worth understanding.

**Semantic roles are CSS variables**, declared once in `src/index.css` and
mapped to Tailwind names in `tailwind.config.js`:

```
--ink --ink-soft --ink-mute --ink-faint        text, by how quiet it may be
--surface --surface-sunk --surface-raised      the ground and what sits on it
--surface-field --surface-tint
--line --line-soft                             the one hairline
--accent --accent-strong                       teal as *writing*
--good --warn --bad --info (+ -bg)             status
```

A role describes a job, not a shade: `text-ink-mute` means "the quietest thing
that may still carry body text on whatever this screen stands on". That is what
makes the ground swappable — retheming is these values, not a sweep through
forty files.

**Saturated fills stay literal.** `bg-brand-600 text-white` specifies both its
face and its label, measures 4.75:1 wherever it lands, and has nothing to
theme. The brand ramp, the logo teal and the outcome swatches are all in this
category.

The one thing that catches people out is that **teal writing and teal fills are
different tokens**. The readable teal inverts with the ground — `#087F8C` on
white, `#20C4D3` on this — so anything that means "teal text" says `text-accent`
and stays right either way. A step number cannot express that, which is why
`text-brand-600` no longer exists.

### Contrast is measured, not chosen

```bash
npm run verify:contrast
```

82 assertions, no browser needed. It reads the real values out of `index.css`,
`charts/tokens.ts` and `FieldMap.tsx` rather than restating them, so editing a
variable and forgetting the consequence fails here instead of on a doorstep.
It covers text on every surface, the machined faces measured *at their lightest
point* (the sheen falls exactly where a label sits), the status pills, the map
swatches against the basemap, and the chart chrome — which restates the theme as
hexes for the SVG renderer and is therefore a second source of truth worth
pinning.

It also asserts a *ceiling*: `ink-faint` must stay under 4.5:1. It is dividers
and placeholders, and the day it passes as text is the day the distinction this
palette rests on is gone.

### The wordmark does not take the theme

`<Wordmark>` puts the real artwork — black "ALLSTAR", teal star, teal "HOME
SOLUTIONS" — on its own white tile. The mark is fixed; a brand that changes
colour with its surroundings is not a brand, so it gets the light ground it was
drawn for and that tile sits on the dark.

Use the component rather than an `<img>`. The rule is easy to forget at the
second call site, which is exactly what happened once: the console's rail kept
the real artwork while the ground went dark underneath it, and the wordmark
spent a release as a black shape on a black panel.

`public/logo-light.png` is the recoloured knockout this replaced. Nothing
references it.

Two things it deliberately does not claim:

- **The chart series' colour-blindness separation is inherited, not re-run.**
  The blue/orange pair was validated on a white surface with a palette validator
  that is not in this repo. The hues are unchanged and both were lifted by a
  similar step, so it should hold — but "should" is not "measured".
- **Google's basemap is not ours to theme.** `GoogleFieldMap` now asks for
  `colorScheme: 'DARK'`, which covers vector maps, but a Map Style attached to
  the Map ID in the Cloud console overrides it. If the real map comes up light,
  that is where to look.

### The teal edge

Every raised control wears a teal edge, and it comes from two tokens rather than
from each rule choosing its own:

```css
--edge:        rgb(var(--accent) / 0.4);          /* a control at rest */
--edge-strong: rgb(var(--accent-strong) / 0.8);   /* the one that is chosen */
```

`--edge` measures 2.37:1 against the sunken ground, where the navy hairline it
replaced managed 1.55:1 — the difference between an edge you see in sunlight and
one that is merely present.

**The gap between the two is the load-bearing part.** Before this, a teal ring
meant *selected*, because nothing else had one. Now a ring means *control*, and
only its strength means selected — and the selected and unselected row faces
differ by just 1.33:1, which is not enough on its own. That is not hypothetical:
a selected row nobody could pick out is a bug this app has already shipped once.
`--edge-strong` sits 3.9:1 clear of `--edge`, and `verify:contrast` asserts both
ends — that the resting edge beats the hairline it replaced, and that selection
still reads against a control merely at rest.

What deliberately does **not** get an edge:

- **Fields.** An input is recessed, a control is raised; that difference is how a
  rep can tell what they can press. `.field-sunk` and the console's inputs keep
  the neutral hairline.
- **Rows in a list.** A property row is separated from its neighbours by a
  hairline and has no gap around it. Edging 160 of them would be a wall of teal
  boxes, not a set of buttons.
- **Red and green.** `.metal-danger` and `.metal-success` keep white rings — a
  destructive control that looks like every other control is a control someone
  presses by mistake.
- **The primary button.** `.metal-brand`'s face is already the brightest teal on
  the screen; a teal ring on it would be invisible and pointless.


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

## Before this goes to a paying customer

Deliberate compromises taken to keep the prototype moving. Each is fine for
building and testing and each is a real defect at launch, so they are written
down here rather than left in a chat log.

### The MapTiler key allows unknown origins

`Allowed HTTP Origins` on the MapTiler key includes `?`, which permits requests
that arrive with no `Origin` header.

It is there because the key has two incompatible jobs and the free plan allows
only one active key. The browser needs it origin-locked, because Vite compiles it
into the bundle where anyone can read it. The Worker needs it origin-free,
because a Worker sends no `Origin` and MapTiler rejects header-less requests when
any origin is listed. `?` satisfies both.

What it costs: another website embedding the key is still blocked, because a
browser always sends an `Origin`. A script or `curl` is not. Anyone who reads the
key out of the JavaScript bundle can use it.

What that is worth today: the free tier is a hard 100k/month cap with no overage
billing, so the worst case is the map going blank until the month rolls over —
an outage, not an invoice.

Two ways to close it, in order of preference:

1. **Move geocoding into the browser.** The import screen runs on the app's own
   origin, so a fully origin-locked key works there, and the Worker stops needing
   a MapTiler key at all. Census stays on the Worker as the fallback. Roughly
   half a day, and the key goes back to being properly locked.
2. **Pay for a plan that allows two keys**, and split them: origin-locked for the
   browser, origin-free for the Worker. No code change.

Whichever is chosen, remove `?` afterwards and confirm with
`/api/selftest/geocode` — its `attempts` array names the provider that answered
and the reason any provider refused.

Note that this compromise buys less than it was meant to. MapTiler is now last in
the chain rather than first (see below), so a rejected key costs almost nothing —
which makes option 1 cheaper to justify and less urgent to fund.

### The npm audit findings, assessed rather than counted

`npm audit` reports 5 findings in the app and 6 in `api/`. All eleven were read.
**None of them are reachable in production**, and every available fix is a major
upgrade, so nothing has been bumped. Recorded here because "11 vulnerabilities" on
a report looks like negligence unless the reasoning is written down.

**The only one that ships to a browser** is `react-router-dom` — an open redirect
via a backslash in `<Link>`/`useNavigate` (advisory range 6.0.0 – 7.17.0). It is
**unreachable in this codebase**: every navigation target is an internal literal
path with an app-generated id interpolated (`/property/${'{'}id{'}'}`), and there is not a
single read of `searchParams` used to navigate. The vulnerability needs a target
influenced by outside input and there is none.

The fix is 7.x, a semver major on the library the whole app navigates through, for
a bug our code cannot reach. **Revisit the moment any feature adds a redirect
parameter, a deep link from an email, or navigation to a stored URL** — that is
what would make it reachable, and it is the sort of thing that arrives quietly.

**Everything else is a development tool and does not reach the deployed app:**

| Finding | Where it bites | Why it is not shipped |
| --- | --- | --- |
| `vite`, `esbuild` | the dev server | Path traversal and cross-origin requests against `npm run dev`, on a developer's machine. The fix is Vite 8, a major bump to the build. |
| `playwright` | the test runner | Downloads browsers without verifying them. This project never downloads one — `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, with a pinned local binary. |
| `wrangler` and its tree (`sharp`, `undici`, `ws`, `esbuild`, `miniflare`) | `wrangler dev` and the build container | None of it is bundled into the Worker; the deployed script is this repo's code. The fix is Wrangler 4, a major bump to a working deploy pipeline. |

One habit worth keeping while these stand: **do not run `npm run dev` or `wrangler
dev` in a browser session that is also visiting untrusted sites.** That is the
whole exposure of the dev-server findings, and it costs nothing to avoid.

What would change this assessment: a critical or a runtime-reachable finding, or
any of these fixes becoming non-major. Worth re-running `npm audit` at that point
rather than on a schedule.

### Pins are block-level, not rooftop

Every lead's pin is interpolated along a street, not placed on a building. A rep
walking a route gets the right block and the right side of the street; they do not
get the right house from the map alone.

This was meant to be fixed by geocoding with MapTiler, and is not. What was
measured, against two addresses from a live test list with the key working and the
request correct:

| Sent | Returned |
| --- | --- |
| `704 W 40th St, Austin, TX, 78751` | West 40th Street, Austin, **78756** |
| `1302 Deepwood Dr, Round Rock, TX` | Deep **Wood** Drive, Round Rock |

Both times the house number was discarded, the match was the street, and the ZIP
was ignored — with West 40th Street in Texarkana and in Mission behind it at
relevance 0.62. Adding `language=en` to activate MapTiler's documented US address
parser changed nothing.

**What that does not establish** is whether MapTiler has US address points at all.
Both addresses came from `fixtures/test-leads-austin.csv`, which is real street
names with *plausible* house numbers — a house that does not exist cannot be found
by anyone, so the test cannot tell thin coverage apart from a bad address.
Settling that needs a verified address, and it is still open.

**What it does establish** is the failure mode, which is what the chain order is
built on. Census answers an address it cannot resolve with a no-match. MapTiler
answers with a confident-looking street in the wrong ZIP. A wrong pin is worse
than an absent one, because an absent one is visible — so Census is first and
MapTiler is last, and a guessed match never ends the search.

`GET /api/selftest/geocode?raw=1&address=...&city=...&state=...&zip=...` shows the
raw provider response, and takes `language`, `types`, `limit`, `autocomplete`,
`fuzzyMatch`, `proximity` and `bbox` off the query string so a hypothesis costs a
page reload rather than a deploy. Use a verified address with it — a synthetic one
cannot answer a coverage question.

### Navigate stays in the app

Tapping Navigate used to open Google Maps in another tab. That had a real cost:
the visit gets logged in *this* app, so a rep who left to look at a map had to
find their way back before anything was recorded.

`/navigate/:id` draws the walking route instead — the actual path along the roads
from where the rep is standing to the door, with the real distance and time. The
polyline comes from `POST /api/directions` on the Worker, because the browser key
is restricted to Maps JS, Places and Street View and cannot spend routing quota;
Routes API is on the Worker's key. One extra hop to keep that split intact.

**It is not turn-by-turn navigation and does not pretend to be.** A web app cannot
speak directions or keep running in a pocket, so "Google Maps" stays one tap away
for driving between neighbourhoods. This screen is for the last two hundred
metres, on foot, which is most of a rep's day.

Four degraded states, each saying which one it is rather than showing an empty
map: no location permission (both fixes named, including the one needing no
permission from us), no signal, no walkable route between the two points, and the
demo account, which has no server to ask and will not invent a path.

**Which number is on screen is always labelled** — "along the roads" or "direct
distance". A road distance and a straight line can differ by a factor of three, and
a rep planning around the wrong one walks into a fence.

`npm run verify:navigate` covers the states rather than the line, since the line
needs a real key: that Navigate no longer opens a tab, that a rep with no location
gets both fixes and *no* route panel offering controls for a route that does not
exist, and that the demo labels its straight-line distance honestly.

### Too far to route, and the line that still shows

Asked directly: what does a rep see when they are in another state, or another
country? Nothing was routable and nothing was drawn, which was honest and
useless. Now the direct path is drawn — a dashed arc with a plane on it, from the
rep to the door — and the distance reads "8,397 mi · direct distance".

**It costs nothing.** `greatCirclePath` in `src/lib/geo.ts` is arithmetic on the
device, so no request, no key, no signal needed. Maps JS bills per *map load*;
polylines, markers and `fitBounds` are free inside a load already paid for. And
no Routes call happens at these distances at all — `Navigate` refuses over 49
miles and `api/src/directions.ts` refuses over 80 km, both before any request.

**Why it is an arc and not a line.** A straight line on a Mercator map is not the
direct path. Manila to Austin looks like it should cross the middle of the
Pacific; the shortest path actually passes north of Japan and clips the
Aleutians, about 22 degrees of latitude above either end. Drawing the chord would
be a picture of a route nobody flies — and it comes out 13,951 miles when the
real answer is 8,397, because linear interpolation goes the wrong way round the
world. The path is sampled at 64 segments, which also means any renderer joins
consecutive points the short way and the antimeridian needs no special case.

**Dashed, with a plane, on purpose.** A solid line between two continents reads
as a route. Same geometry, different promise, and the promise is the part a rep
acts on — so `pathKind: 'flight'` draws it dashed and puts a plane at the arc's
midpoint, rotated to the bearing.

No walking time is quoted beyond the walk limit: that number used to be
unconditional, so a lead opened from abroad read "8,397 mi · 162,533 min",
arithmetic wearing the clothes of a plan.

**It is a state the screen succeeds in, not a failure.** Internally this was
`failed: 'too-far'` at first, and modelling it that way is what made everything
downstream treat a rep in another country as a broken app — the renderer was
dropped, the reason competed with "no signal", and the screen apologised for a
fact about geography. It is now `direct`, carrying its own path and distance,
with `failed` left to mean only the three cases where we could not find out:
no signal, the demo account, and a deployment with no routing configured. (The
app-wide online state never came into it either way — that is `navigator.onLine`
in `src/lib/api.ts` and nothing on this screen touches it.)

**Both renderers draw it.** `FieldMap` used to stop at zoom 12, a neighbourhood,
so the far-away case had to be Google-only — and a rep on the wrong continent
with no signal got a map of the door and nothing else. Two renderers that
disagree about what they can show is exactly what the shared prop contract exists
to prevent, so the floor is now zoom 1 and `FieldMap` takes the same `path` and
`pathKind` props. Three things had to change with it:

- **The projection wraps.** `toScreen` takes longitude as a `wrapDegrees` offset
  from the centre rather than an absolute world coordinate. Identical arithmetic
  inside one hemisphere, and it is what stops a Manila-to-Texas line being drawn
  the long way back across Asia. `fitZoom` and the new `fitCenter` measure the
  same way — measured absolutely, that pair spans 218° and both the zoom and the
  centre come out describing the wrong two thirds of the planet.
- **The basemap changes with the zoom.** The drawn grid is a synthetic lattice at
  block spacing: real spatial texture where a rep works, and at continental scale
  both a lie and roughly fifty thousand SVG lines. Below zoom 12 it draws the
  true graticule instead — coarse, thin, spacing picked from the visible span.
- **The view fits the line once.** Not on every render, or a rep could never pan;
  and following the rep is switched off, because centring one endpoint puts the
  other off screen by a continent.

This also fixed the renderer choice, which hung off *any* routing failure — so
the far-away case was being handed to the one renderer that cannot show two
continents. Only the map failing takes the map away now. Doing that reintroduced
a bug in passing: the map's own failure wrote "No signal" over the top of the
real reason, which is exactly the wrong-reason bug this screen was fixed for
once before. `verify:navigate` caught it, which is the whole argument for having
written that assertion.

`npm run verify:flightline` is the one gate here that runs no browser, because
what can be wrong is arithmetic. Node imports `src/lib/geo.ts` directly — type
stripping, no build step — so it tests the real function: that the drawn line's
own length equals the great-circle distance, that the arc bows north of both
endpoints, and that it crosses the antimeridian. Swapping in linear
interpolation fails four of those assertions, which is how they were checked.

And because the offline renderer draws the arc, `verify:navigate` can assert the
line itself with **no key at all** — Maps JS is blocked in that gate, so what is
measured is the self-rendered map: 65 vertices rather than two, both ends on
screen, the plane present. Putting the zoom floor back to 12 reports a line
29,251px wide starting at x=−14,430, which is the failure that assertion is
for.

### A photo of the house, and the trap under it

`StreetView` answers a porch question no amount of address text does: *is this
the right house?* Missing kerb numbers, shared driveways, a flag lot behind
another property — a rep twenty feet away has an address and a pin and no way to
recognise the door.

A still image, not the interactive panorama. The panorama is a WebGL canvas that
loads and initialises, on a screen a rep opens dozens of times a day, to answer
what one photo answers instantly. Tapping the photo hands off to Google Maps for
a proper look around, which is free and better than the embedded version.

**The trap:** asked for a location it has no coverage for, the Street View Static
API does not fail. It returns a grey placeholder image, status 200, reading "Sorry,
we have no imagery here". Rendered blindly, a rural lead shows a photo of nothing
and looks like a bug. So the free metadata endpoint is consulted first and the
image is only requested when there is something to see — which also means an
uncovered lead costs no image request at all.

With no signal there is no photo and no message. Everything else on that screen
works offline, and an apology for a missing nice-to-have would be noise at a door.

`npm run verify:streetview` drives all three cases by stubbing the metadata
endpoint: coverage, no coverage, no network. Writing it surfaced a Playwright
subtlety worth knowing — in a URL **glob**, `?` matches any single character, so
`streetview?*` also matches `streetview/metadata?…`. The image stub was answering
the coverage check with a PNG, and the test blamed the component for behaving
correctly. The stubs use regexes now.

### The map screen searches leads before it searches Google

`MapSearch` sits where the property-count pill used to be — the count moved into
its placeholder rather than taking a third band of chrome over a full-bleed map.

Typing searches **the leads already on the device**: house number, street, town and
contact name, nearest first when the rep's position is known. Instant, free, and it
works in a dead zone. Only when nothing local matches does it offer the text as an
address to move the map to, and those results are labelled *"Not a lead"* so a
found address is never mistaken for a found lead.

That ordering is not politeness. The local search is free and offline and usually
the right answer; the address lookup is billed per session and needs signal. A
query that already matched a lead never reaches Google at all.

`npm run verify:mapsearch` covers the lead half at 320/390/1024 with Google
unreachable, because that half needs no key to be true. Two real bugs came out of
writing it, and both are the kind that only a browser finds:

- The invisible full-screen backdrop that dismisses the results sat **above** the
  clear button, so tapping ✕ with results open hit the backdrop and appeared to do
  nothing. The second time an unpainted overlay has quietly eaten taps here — the
  first was the map's peek sheet.
- The pill measured 44px but the `<input>` inside it measured 36px, and tapping the
  pill's padding focuses nothing. The field *looked* like a thumb target while the
  part that takes a tap was smaller than one.

### Address entry suggests, and never depends on suggesting

`AddressAutocomplete` offers Google Places suggestions as a rep types, and is a
plain text input the rest of the time. With no key, no signal or a rejected key it
behaves exactly as the field did before suggestions existed — type it, save it, no
complaint. That is the whole design constraint: this screen is used outdoors, and
a billed convenience must never become a dependency.

Google's own `PlaceAutocompleteElement` was not used. It brings its own markup and
its own row heights, and this app has spent real effort on 44px tap targets and
one-handed reach; a widget that ignores both on the one screen a rep uses in gloves
is not a saving. The data API plus our own list costs about forty lines.

A picked address is worth more than the typing it saves, because it carries
coordinates and a **structured** address. That fixed two existing faults:

- The screen wrote a hardcoded `Round Rock, TX 78664` onto every lead added from
  the field, whatever town the rep was in. Invisible with one territory, wrong the
  moment there are two. A typed address now stores its city, state and ZIP
  **blank** — the office can see blank and fix it; it cannot see a confidently
  wrong town.
- Adding a lead needed GPS, so a rep whose browser had blocked location found Save
  dead with nothing explaining why. A picked address sets the pin without any
  permission at all, and when there is neither pin nor pick the screen now names
  both fixes instead of just refusing.

Billing discipline, since Places charges per session: requests wait for a pause in
typing, need three characters, are limited to US street addresses, and share one
session token until a pick ends it. Typing an address is one billable session, not
fifteen.

`npm run verify:newlead` asserts the degraded path and reads the saved row out of
IndexedDB rather than trusting the form — the offline write is the thing that
matters. The suggestion list itself is not covered, for the same reason as the map:
it needs a real key on an allowed origin.

### The map has two renderers: Google online, MapTiler offline

`GoogleFieldMap` uses the Google Maps JavaScript API. `FieldMap` draws its own
basemap and layers cached MapTiler tiles over it. They share one prop contract, and
the screen picks between them by whether Google is currently drawable.

| | Online | Offline / Google failed |
| --- | --- | --- |
| Both Google vars set | Google map | `FieldMap` with whatever tiles are saved |
| Either missing | `FieldMap` | `FieldMap` |

The route list is a **choice**, reached from the map/list switch — not a fallback.

That last part was wrong for a while and worth recording, because the failure was
silent. A failed Google load used to jump straight to the list, which meant that in
production — where Google is always configured — `FieldMap` never rendered, and the
MapTiler tiles a rep downloaded through **Offline maps** were never drawn. The
territory download had become unreachable: the one moment it exists for was the
one moment the screen stopped using it. Imagery now comes first, and the gate that
asserted the old behaviour has been rewritten, because it was defending the bug.

The self-rendered map is not legacy code waiting to be deleted. It is the only
renderer that works with no signal, no key and no billing account. With the Google
vars unset, Rollup proves that branch dead and strips the renderer and its
clusterer from the bundle — a deployment that does not use Google pays nothing for
it. With them set, the whole Google path costs about 6 kB raw, 2 kB gzipped.

**Connectivity is never checked directly.** Offline, a rejected key, a blocked
script and a stalled connection all arrive as one thing: a named load failure. All
of them want the same response — draw the offline map and say which one happened.
A separate `online` check would be a second source of truth that disagrees with
the first on exactly the flaky connection this screen exists for.

The notice over the fallback map splits on purpose. Connectivity gets a rep's
sentence; everything else keeps the provider's own words. A rejected key is the
most likely thing to break on a new deployment and the least guessable, so
collapsing it into "map unavailable" would throw away the one message that tells
whoever deployed it what to fix.

Advanced markers are why the Map ID is required rather than optional. They render
as real DOM, so the status colours and selected state already in this product carry
over instead of becoming Google teardrops, and they are focusable, which sprite
markers are not. Without a Map ID they silently do not appear — so a key with no
Map ID is treated as unconfigured, and says so in the console.

Two gates need a build with placeholder Google values, because with the vars unset
the code under test is not in the bundle. Both skip cleanly rather than failing,
detected from the absence of any request:

```bash
VITE_GOOGLE_MAPS_KEY=dummy VITE_GOOGLE_MAP_ID=DEMO_MAP_ID npm run build
npm run verify:googlemap && npm run verify:streetview
```

`verify:maptiles` does the opposite — it blocks Google, because `FieldMap` is now
the offline renderer and would otherwise never appear on screen to be tested. That
is also the condition a rep is in when those tiles matter.

### Google's terms and the offline map are in direct conflict

Only relevant once `GOOGLE_MAPS_API_KEY` is set, and then it is the most
important item on this list.

Google's Maps Platform terms permit only *temporary* caching of latitude and
longitude — on the order of thirty days — after which they are to be deleted.
Place IDs are the stated exception and may be stored indefinitely.

This app does the opposite, deliberately. A lead's coordinates are written to D1
and to every phone's IndexedDB and kept for the life of the record, because the
map has to draw with no signal — which is the product's founding requirement, not
a convenience. So this is not a bug to fix in code; it is a conflict between the
offline requirement and the provider's licence.

The compliant shape is to store the Place ID as the durable reference and resolve
coordinates at display time. That costs the offline map, which is the one thing
this product is built around.

The three ways out, none of them free:

1. **Accept it and get it reviewed.** Ask counsel whether the field-sales use and
   retention period are defensible, in the same conversation as the DNC/TCPA
   review. Cheapest, and a real answer rather than a guess.
2. **Google for display, a storable geocoder for storage.** Google Maps for the
   basemap and Street View; coordinates from a provider whose terms allow
   permanent storage. Keeps the offline map, keeps rooftop accuracy, and the pins
   are no longer Google-derived. Needs one more paid provider.
3. **Place IDs, resolved online.** Fully compliant, and the offline map goes.

Nothing in the code prevents any of these. What the code does is refuse to
pretend the question isn't there: the constraint is recorded in
`api/src/geocode-google.ts` next to the provider it governs, and in
`api/wrangler.toml` next to the secret that activates it.

Closing the rooftop gap needs a provider with a US address-point database. The
candidate worth pricing is **Geocodio** — US and Canada only, which matches this
market, rooftop-level from OpenAddresses plus TIGER, no requirement that results
be shown on the provider's own map, and cheap per thousand with a free daily
allowance. That last property is why this is not simply "switch to Google", which
would reintroduce the licensing question the MapTiler move was made to retire.

Until then, do not describe pins as rooftop-accurate to a customer. The import
preview is honest about it — a guessed match is flagged "close match — check this
one" and the precision of every row is shown — and that honesty is the mitigation.
