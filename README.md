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

### Asking for location once

Reported from a real browser: the permission prompt kept reappearing while
moving around the app.

The cause was not one bug but an absence. **Every call to `getCurrentPosition`
is its own permission request**, and a browser prompts on each one until somebody
makes a *persistent* choice — so a rep who taps "Allow this time", or dismisses
the bar, is asked again on the next screen. Four places were asking
independently: the shared watcher, a refresh on boot and sign-in and
pull-to-refresh, a stamp on visit start, and the new-lead form.

The worst of them was a loop. The new-lead form listed the store's position among
its effect's dependencies, so every fix the shared watcher produced re-ran the
effect and asked for the position again — **a request per second for a rep who is
walking**, each one a prompt.

`lib/geo.ts` is now one source for the whole app:

- a fix newer than the caller's freshness window is returned without touching the
  browser at all
- concurrent callers share one in-flight request instead of stacking prompts
- the shared watcher fills the same cache, so once it is running the rest of the
  app already has an answer
- a permission already **denied** is never called again — `permissions.query`
  answers that without prompting, which is the whole point of it

Freshness is the caller's choice, because it is a claim about the data rather
than a performance knob. Two minutes is the default; starting a visit asks for
thirty seconds, because that stamp is a record of *where the rep stood* and one
three houses stale is a false record.

```bash
npm run verify:location
```

It counts **requests to the browser**, not prompts. Playwright grants geolocation
up front and never shows a prompt, so counting prompts would be untestable —
while one request is one prompt on the browser the complaint came from. The stub
moves the reported position on every fix, modelling a rep who is walking, because
that movement is what drove the loop.

Every move between screens goes **through the app**, never `page.goto`. A `goto`
is a document load: the init script runs again, the counters reset, and a
before-and-after comparison spanning one cannot fail. The first version of this
file did exactly that and passed with all three bugs put back in — which is the
only reason it is worth writing down.

### Asking the browser to keep it

All of the above is worth nothing if the browser throws it away, and by default
it may. Script-writable storage is *best-effort* unless a site asks otherwise: a
browser short of disk can evict it, and iOS Safari clears it after seven days of
not opening a site that is not installed to the home screen.

For a field app that is a rep back from a week off finding an app that looks
freshly installed. Leads re-download; anything still in the outbox does not,
because the server never heard of it.

So `requestPersistence()` runs at every launch — fire-and-forget, since nothing
on screen depends on it and a permission check has no business delaying first
paint. Every launch because it is idempotent once granted, and because browsers
weigh engagement: a request refused the day someone installed the app is often
granted a week later, and asking again is the only way to find out.

It is **granted, not requested**. Browsers decide, mostly on whether the site is
installed. So the answer is reported rather than assumed — More → Saved on this
phone shows *Kept* or *May be cleared*, and the second comes with the one thing
that actually fixes it (add it to the home screen) and an honest limit on the
worry (whatever already reached the server is safe either way).

```bash
npm run verify:persistence
```

Stubs `navigator.storage` rather than driving a real browser's answer, which is
a property of the harness and not of this code. What it asserts is our side: that
the app asks, asks **once** rather than on every navigation, does not re-ask a
browser that already agreed — `persist()` can prompt — survives a refusal, and
reports the answer it got rather than the one it wanted. A storage manager that
throws instead of answering, as some engines do in private browsing, counts as a
refusal and not as a crash.

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

### Which territory a lead lands in

An import used to assign a territory only if the operator typed one for the
whole file. Everything else arrived unowned, and somebody assigned it by hand —
which for a 500-row list is most of a morning.

Now each lead's coordinates are matched against the drawn boundaries, and the
patch's rep comes with it. The rules, in order:

1. A territory named on the import screen wins for every row. An explicit choice
   is an explicit choice; matching is skipped entirely rather than competing
   with it.
2. Otherwise, the lead goes to the drawn territory containing its coordinates.
3. A rep named on the import screen wins over the patch's rep.
4. A lead inside **no** territory stays unassigned. It is not pushed into the
   nearest one — a lead ten miles outside every patch belongs to a person
   deciding.
5. A lead with no usable coordinates is not counted as unmatched. It failed to
   geocode; that is not the territories' fault.

**Overlaps resolve to the smallest patch.** A downtown territory carved out of a
city-wide one is the normal case, not a mistake, and "the bigger one wins" would
put every downtown lead in the city bucket. Two patches of *equal* area tie-break
by id — rare, but without it the winner is whichever row D1 returned first, which
is free to change between imports and would move leads between reps with nothing
in the audit log to explain it.

The result reports `territoryMatched` and `territoryUnmatched`, and the wizard
says so, because "every lead found its patch" and "no territory has a boundary
yet" otherwise look identical: both are a successful import, and only one of them
leaves somebody a day of work.

### The geometry is duplicated on purpose

`api/src/geo.ts` copies `pointInPolygon` and `polygonAreaSqMiles` from
`src/lib/geo.ts`. The Worker is its own package with its own tsconfig and bundle;
reaching into the browser app's module graph to borrow forty lines would couple
two builds for the life of the project.

Copies drift, and drift here is silent and expensive: a manager draws a patch and
the console says it holds 340 leads, while the import puts a different set in it.
Nothing errors, and the first person to notice is a rep knocking a street that is
not theirs.

```bash
npm run verify:geo-parity
```

Runs both copies over the same fixtures — a square, a concave notch, a
reverse-wound ring, and a 5,000-point grid including vertices and on-edge cases —
and fails on any disagreement. Also covers the malformed boundaries that must be
dropped rather than repaired, since guessing what a manager meant puts real leads
in a patch nobody drew.

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

## The board, and how far back it looks

Door-to-door runs on the standings. A rep who cannot see where they stand at 2pm
has no reason to knock the next street.

For a long time the board knew about **today only**, which is right for 2pm and
wrong for everything else. It told a rep who had a strong week and a slow Tuesday
that they were nowhere, and it gave somebody who joined last month no window they
could ever win — every window was one day long and the good days were already
spent. A week is a length of time a person can actually change.

**Today / Week / Month**, and Today is the default on every visit. Not
remembered between visits on purpose: at 2pm the question is about this
afternoon, and a rep who looked at the month once last week should not have to
notice a filter before trusting the number in front of them.

### Where each day's numbers come from

This is the rule with teeth. `daily_stats` is written by the **server**, so a rep
working a street with no signal has a morning that exists only on their phone.
A week summed from history alone would show them a week with today missing — on
the one screen whose entire job is telling them where they stand right now.

So history supplies the days *before* today, the device supplies today, and
neither can be counted twice. Sum the whole range including today's history row
and a synced morning appears twice; drop the live day and an unsynced one
vanishes. `verify:periods` fails on both.

### Money stays out of a week

`daily_stats.pipelineValue` is not a daily figure. It holds a running lifetime
total of everything the rep has ever won, stamped onto whichever day the write
happened, so adding it across a week produces a number with no meaning. A period
board therefore carries no revenue at all, and the revenue award suppresses
itself — an award nobody can earn beats one handed out on a wrong number.

*(The console does sum that column, which is a real bug in the money figures on
Dashboard and Reports. It is on the list, and it is not this screen's to fix.)*

### The week starts on Sunday

One named constant, and the one line to change if a customer disagrees. US sales
weeks are conventionally Sunday-to-Saturday and the rest of the app formats dates
as `en-US`, so a Monday start would put "this week" out of step with every
calendar a rep looks at. Teams that knock Monday to Saturday get Sunday at the
front of their week rather than the end, which is the cost.

```bash
npm run verify:periods
```

The clock is passed in rather than read, so "what happens on the 1st" and "what
happens on a week that starts in the previous month" are assertions rather than a
wait. Also covers the parts that are about people rather than arithmetic: history
belonging to somebody off the roster does not resurrect them onto the board, and
a rep who has knocked nothing this week is still on it at zero — a board you
appear on only after you perform is a receipt, not a board.

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

## Backups, and proving they work

The state before this section existed: nothing scheduled an export, nothing was
written down, and the only thing between this account and total loss was D1's
Time Travel — which is real, and automatic, and not the whole answer.

### Two disasters, two answers

**Somebody ran the wrong statement an hour ago.** Time Travel. It is built into
D1, needs no setup, and rewinds the database to any point in the last thirty
days. This is the disaster that actually happens, and it is already covered.

```bash
cd api
npx wrangler d1 time-travel info allstar-db --remote
npx wrangler d1 time-travel restore allstar-db --timestamp <ISO-8601> --remote
```

**Everything else.** Time Travel is bounded at thirty days, so a corruption
noticed in month two is past its reach. And it lives *inside* the account: a
closed, compromised or mis-billed Cloudflare account takes it along with the
database it was protecting. A backup that shares the fate of the thing it
protects is not a backup.

```bash
cd api
npm run backup            # → api/backups/allstar-db-<utc>.sql.enc
```

Under the encryption it is plain SQL, so it restores into D1, into SQLite, or
into anything that speaks the dialect — "we can restore" should not depend on one
vendor still being willing to serve you.

### The key, and why there is no backup without one

The file holds every customer's addresses, contact names and phone numbers, plus
password hashes. `backups/` being git-ignored keeps it off GitHub and does
nothing whatsoever about the copy on a laptop, in a Downloads folder, or in
whatever cloud drive that laptop syncs to — and the file exists in order to be
copied somewhere else. Encryption is the only control that survives it leaving
the machine it was made on.

So `npm run backup` **refuses to export production until a key exists.** It does
not write the plaintext "for now": that is how every one of these ends up
unencrypted, and the file would be synced, indexed and forgotten long before
anybody came back to it. Same posture as `INTEGRATION_KEY` in the Worker — no
key, no operation.

```bash
openssl rand -base64 32          # once, ever
```

Then either export it as `BACKUP_KEY`, or save it to `api/.backup-key` (which is
git-ignored). Committing it would put the key and the ciphertext in the same
place, which is the one arrangement that makes the encryption worth nothing.

**Losing it is unrecoverable, and that is worse than it sounds.** This is not
`INTEGRATION_KEY`, where a rotation costs every customer a reconnect, and not
`SESSION_PEPPER`, where a rotation signs everyone out. Lose this and every backup
written with it is permanently unreadable — the disaster the backups existed to
prevent, arriving by a different road. It belongs in a password manager, not only
on the disk that holds the backups, and old keys are kept forever rather than
replaced: a file from before a rotation still wants the key it was written with.

`--plaintext` exists for the local dev database, which holds generated seed data,
and is refused against production.

### Reading them back

```bash
cd api
npm run backup:list                        # no key needed
npm run backup:open backups/<file>.sql.enc # writes plaintext — for a real recovery
```

The header — when it was taken, which database, how much SQL is inside — is
stored in the clear on purpose, and `backup:list` reads it without the key. A
directory of files that cannot be told apart without opening each one is a
directory where a recovery starts by guessing, and the only thing worse than no
backup is restoring last month's over this morning's. The header carries no
secret, and it is fed to AES-GCM as additional authenticated data so it cannot be
edited either.

`backup:open` is for an actual restore, not for testing one — the drill below
decrypts on its own and cleans up after itself.

**The format.** AES-256-GCM, key derived with scrypt over a per-file salt, tag as
a trailer over the whole stream (`api/scripts/lib/backup-crypto.mjs`). GCM rather
than a plain cipher for tamper detection, and for the case that comes up far more
often: truncation. An export into a full disk, an interrupted copy, a sync client
that uploaded half a file — every one of those produces a dump that restores
cleanly *up to the cut*, and the tag turns all of them into a refusal at the
door. scrypt rather than the single SHA-256 that `secretbox.ts` uses, because
this runs twice in the life of a file rather than on every request, so slow costs
nothing, and the secret is one a human may have shortened or typed from memory.

### The drill

A backup nobody has restored is a rumour. The failure mode is discovering during
an incident that the dump was truncated, or that it restores a schema the Worker
then tries to migrate again, or that it brings back rows whose foreign keys point
at nothing.

```bash
cd api
npm run verify:restore backups/allstar-db-<utc>.sql.enc
```

An encrypted backup is decrypted by the drill itself, into the same scratch
directory it deletes at the end. That is not convenience: the alternative is
running `backup:open` to test a file and leaving the plaintext sitting next to
the encrypted copy, which would undo the encryption every single time the drill
was run. Proving a backup works must not be the thing that exposes it. A file
that fails to authenticate is reported as a failed drill, because that is what it
is — wrong key, damaged, or altered, and the file cannot say which.

It restores into a scratch database in a temp directory with its own name and its
own state — it cannot reach the database the backup came from, because a restore
test that can damage production is a second disaster queued behind the first.
Then it asks, in the order the failures actually happen:

| | |
|---|---|
| is it a database at all | not an error page somebody saved, not a truncated write |
| every table came back | read from `schema.sql`, so a table added later is covered without anyone remembering |
| the rows came back | counted against the dump's own INSERTs — this is what catches a truncated file that still parsed |
| foreign keys intact | no row pointing at a parent that is not there |
| SQLite agrees | `integrity_check` |
| the ledger came back | see below |
| it is a *usable* account | a client, a user, and their credentials — non-empty is not the same as usable |

**The migration ledger matters more than it looks.** Restore without
`schema_migrations` and the Worker's first request re-runs every migration
against a schema that already has them. The additive ones are idempotent; the
`ALTER TABLE` is not, and the migration state goes to `failed` on a database that
is otherwise perfectly fine. That case restores *cleanly* — it is the one silent
failure in the list, and the drill names exactly which migrations would re-run.

The restore goes through D1, because that is the path a real recovery takes. The
reads do not: D1 refuses `foreign_key_check` and `integrity_check` outright
(`not authorized: SQLITE_AUTH`), so the checks that catch a silently broken
restore are read off the restored file directly. That also took the drill from
three minutes to eleven seconds, and a drill nobody runs is not a drill.

Proved by feeding it bad backups: a dump truncated mid-write, an auth error saved
with a `.sql` extension, a dump missing its users, one missing its ledger, and one
with an orphaned foreign key. Each fails, and each fails in a way that says what
is wrong.

### Running the API tests

```bash
cd api && npm run smoke:all          # everything
cd api && npm run smoke:all -- --fast   # the pure checks only, seconds
cd api && npm run smoke:all -- crm      # only names containing "crm"
```

There were seventeen API-side tests and nothing that ran them. The browser suite
has had `verify:all` for a while; the API side meant typing seventeen names and
knowing which need a server, which need an administrator to exist first, and
which cannot run unattended at all. That knowledge lived in one person's head,
which is the same as it not existing — and it is why the newest and most
security-sensitive tests here, the CRM push, the CRM webhook and erasure, were
written, proved, and then left somewhere nobody would run them.

**They are not uniform, and the runner does not pretend they are.** Four kinds,
because treating them alike is how a runner reports setup problems as failures:

| | |
|---|---|
| **pure** | no server. Parsing, arithmetic, structure. Run first, so a broken build costs seconds rather than four minutes of Worker startup |
| **hosted** | brings its own Worker, port and database. Strictly serial — two at once collide on `.wrangler` state and the second silently tests the first one's data |
| **shared** | expects a Worker on 8787 *and an administrator to exist*. `smoke:onboarding` creates that administrator, so these are ordered, not merely grouped |
| **manual** | `verify:restore` needs a backup file. Reported as skipped **with the reason** — a suite that quietly runs sixteen of seventeen lies about its own coverage |

**The failure it is shaped around** is the one the browser runner learned the hard
way: when that suite's preview server died, 28 gates failed with connection errors
and the summary read as 28 bugs. It is worse here, because the shared Worker takes
a minute to come up and everything behind it fails identically. So the server is
checked before *each* shared test, and if it has gone the run says so and stops
rather than printing a list of failures that are all one failure. Hosted tests
free their port first, because a Worker left behind by a crashed run would make
the next test exercise the previous test's database — and pass.

**The runner checks that it knows about every test.** A script in `package.json`
that nobody added to its list would never run and nobody would find out, which is
exactly the failure it was built to end. A missing one, or a listed one that no
longer exists, stops the run before anything else happens.

It is slow — most of the time is Workers starting — so it is a thing to run before
a release rather than between edits. `--fast` is for between edits.

### The encryption has its own gate

```bash
npm run verify:backups     # from the repo root
```

The round trip is the half that does not matter — if encrypt-then-decrypt were
broken it would be obvious the first time anyone tried it. Every failure that
costs something is a refusal that did not happen, and each of those passes a
round-trip test happily. So `api/scripts/verify-backup-crypto.mjs` asserts the
refusals: the wrong key, a single flipped byte, a truncated file, a missing tag,
an edited header, edited scrypt parameters, a key short enough to guess, a
production export with no key configured, `--plaintext` aimed at production, and
a failed export leaving staged plaintext behind. Each one also asserts that
nothing was written, because a decrypt that throws *after* writing a partial file
gives a dump that restores cleanly up to the cut.

Confirmed by breaking the code seven ways and watching it fail each time. Two of
those first passed anyway, and both are the same lesson: "it exited non-zero" is
not evidence of a refusal when the test environment makes everything exit
non-zero, and `indexOf('loadBackupKey')` matches the import statement at the top
of the file, so the check that the key is consulted *before* the export could not
fail. Both now assert the reason rather than the symptom.

### What is still missing

**Nothing runs `npm run backup` on a schedule.** The tooling exists and is
proved; the habit does not. That needs either a scheduled job somewhere with a
Cloudflare API token, or a calendar reminder and a person — and which of those is
appropriate is a decision about who holds that token, not an engineering one.
Until it is answered, this account's recovery window is Time Travel's thirty days.

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
sequential ramps for magnitude, status colours reserved for state, legends plus
direct labels so identity never rests on colour. The palette lives in
`admin/charts/tokens.ts` and is measured by `npm run verify:charts`.

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

### Coming back the other way

An upload only the uploader can see is a backup, not a feature. `GET
/api/properties/:id/photos` lists what the server holds for one property, and
`GET /api/photos/:id` serves the bytes.

Deliberately **not** part of bootstrap. A rep's own photos are already on their
phone; this path exists for the ones a device never took — the office opening a
roof shot, a rep on a replaced handset — and fetching those needs the network by
definition. Carrying every photo row in the payload each rep refreshes on every
launch would cost a lot of bytes to save a request the phone mostly does not
make.

Bytes are fetched **per thumbnail**, not per property. A strip is mostly
off-screen: a lead with fifteen shots shows three, and pulling the other twelve
over cellular to fill a container nobody scrolled is what makes a field app feel
broken. Each one is written back to its row on arrival, so the second look is
free and works with no signal — a data URL rather than an object URL for exactly
that reason, since an object URL dies with the tab and the photo would come down
again on every visit.

Merging never deletes. A row the server did not mention may be one this phone
took ninety seconds ago and has not uploaded yet — the same trap `applyBootstrap`
documents at length for every other store.

### The copy stays on the phone

Once a photo is in R2 the local copy could be dropped and re-fetched. It is not,
by decision: a rep opening any photo of any lead with no signal is worth more
than the space, and R2 holds the durable copy regardless.

That makes filling the device a matter of time rather than a maybe — roughly
15MB a day per rep at forty photos, against a browser quota around 1GB. So the
guard is not eviction, it is honesty at the moment of failure. `putAll`
translates a quota error into `StorageFull` (named across engines, since Firefox
and Safari have each had their own wording), and the photo strip says what
happened and what to do about it.

The alternative is the one outcome this screen must never produce: the sheet
closes, the strip stays empty, nothing is said, and the rep walks away from the
house believing they photographed the roof. That is exactly what used to happen
— `addPhoto` threw into a click handler and the error vanished.

`verify:photos` injects a real `QuotaExceededError` at the IndexedDB layer
rather than filling a disk, so there is no test-only branch anywhere in the app.
Writing it turned up a second defect: a failing write aborts the transaction,
which rejects `tx.done` as well, and nothing was awaiting it by then — an
unhandled rejection on every write failure, not just this one.

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

One thing it deliberately does not claim:

- **Google's basemap is not ours to theme.** `GoogleFieldMap` asks for
  `colorScheme: 'DARK'`, and two things can override that. A raster fallback
  ignores it outright, because the dark scheme is vector-only; that half is
  detected on `tilesloaded` via `getRenderingType()` and reported to the console.
  A Map Style attached to the Map ID in the Cloud console also wins over it, and
  that half is invisible from the bundle — a styled vector map reports `VECTOR`
  like any other. The warning names both, so a light map sends the reader to the
  right place rather than the detectable one. See *A light map, and why*.

### A light map, and why

A bright basemap inside a near-black app gets reported as "the map looks wrong"
and then costs somebody an afternoon, because the two causes are unrelated and
neither announces itself.

`lib/basemap.ts` holds the decision as a pure function of the rendering type,
and that is why it is its own module: `lib/gmaps.ts` reads `import.meta.env` at
load and so belongs to a bundler, and a real map needs a real key — a key that
works in CI is a key committed somewhere. A function that takes a string and
returns a string can be tested by anybody.

It reports a raster fallback, and **names the cause it cannot see**. That second
part is the one worth keeping: a warning that says "raster" and stops there sends
whoever reads it to check a device setting on the day the real cause was a style
attached to the Map ID months ago. `verify:basemap` fails if the message loses
it.

It stays quiet on `UNINITIALIZED` and on an API too old to answer, because a
warning that fires on every cold load is one nobody reads by the time it means
something. Anything unrecognised is reported rather than assumed fine.

```bash
npm run verify:basemap
```

Also asserts the function is actually called, with Google's own answer rather
than an assumption, and **on `tilesloaded` rather than at construction** — the
rendering type is not settled until something has painted, so checking earlier
reads `UNINITIALIZED` and the whole thing quietly becomes a no-op. Moving the
call fails that assertion.

### The chart palette, measured in-repo

The console draws two line series, a five-step funnel ramp and four status
colours on a dark card. Colour is doing identity work there: which line is knocks
and which is conversations is carried by hue and nothing else, and roughly one
man in twelve cannot rely on the red-green channel to tell them apart.

That used to be asserted in a comment. The figures came from a validator outside
this repo, and when the app moved to a dark ground they quietly became claims
about a surface that no longer existed — the file said so, which was honest, and
left the numbers wrong, which was still wrong.

So the maths moved in. `scripts/lib/cvd.mjs` carries the OKLab conversions and
the Machado-Oliveira-Fernandes (2009) colour-vision simulation at severity 1.0 —
named because the thresholds are calibrated to *that* model, so it is part of the
standard rather than an implementation detail.

Re-measured against the real dark card, the hand-lifted values failed one check.
The hues were right; the *step* was not. Lifted by eye for contrast they sat at
OKLCH L 0.718 and 0.755, above the 0.48–0.67 band a dark ground wants, which is
where a mark starts to shout instead of sitting on the surface. Stepped properly:

| | before | after |
|---|---|---|
| protan/deutan ΔE | 21.6 | **26.8** (target ≥ 8) |
| normal-vision ΔE | 26.0 | **31.8** (floor ≥ 15) |
| contrast on the card | 6.73 / 7.41 | 4.63 / 4.34 (floor 3:1) |
| lightness band | **fails** | passes |

The contrast is lower, and that is the trade: both stay comfortably above the
floor for a graphic mark, the separation a colour-blind reader actually depends
on went *up*, and the marks stop glaring. The hue pair — blue then orange, in
that fixed order — is unchanged, because the pair *is* the colour-blindness
decision and re-picking it would throw the result away rather than carry it.

The funnel ramp needed nothing: monotone, adjacent ΔL 0.09–0.13 against a 0.06
floor, 4° of hue spread, dim end at 3.07:1.

```bash
npm run verify:charts
```

The gate also checks that **the comments are not lying** — every ratio and ΔE
quoted in `tokens.ts` is compared against what was just measured. A stale comment
is exactly how the last set of figures survived a redesign that invalidated them.

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

## Starting up

`boot()` in `store/useAppStore.ts` is the only path into a running app, and its
ordering is load-bearing in two directions.

The session is read **before** the outbox is started, because `initSync` drains
on start-up and a drain that does not know who is signed in has no correct
destination for the writes.

The cached territory is read **before** the sync bookkeeping. This is the
opposite of how it was first written, and the difference is the whole of #40.
`initSync` and `initPhotoSync` read a timestamp and count two tables — nothing
on any screen waits for those numbers — but they used to be awaited ahead of
`loadLocal`, which is what fills the store. That quietly made every pixel in the
app depend on two IndexedDB reads completing. When one of them didn't, `ready`
never flipped, and the app sat on "Loading your territory…" with no error, no
timeout and no recovery: the code that would have healed it was parked behind
the same `await`. Two gates failed this way on a machine nobody could log into,
and the diagnosis was a Playwright timeout.

Underneath that, `db()` now has a **budget**. `openDB` rejects when IndexedDB is
switched off — that case was always handled, and callers fall back to memory.
What it does not do is reject when an open is *blocked*, which is what happens
when one tab holds the old version of the database while another wants to
upgrade it: the open simply waits, for as long as the other connection lives.
Every read in the app is behind that open, so an unbounded wait is not a slow
start, it is an app that never starts. Ten seconds separates a blocked open from
a merely slow one — a first-run upgrade on a cheap phone finishes inside a
second — and past it the app runs from memory. That trade is deliberate: a rep
who can work and loses their cache on reload is far better off than a rep who
cannot open the app, and the outbox drains from memory exactly as it does from
disk. The other half of the same fix is cooperative: when another tab needs the
upgrade, this one closes its connection instead of deadlocking both.

```bash
npm run verify:boot
```

...checks the ordering in the source *and* drives a browser whose IndexedDB
never opens, asserting the app still reaches a screen a rep can use. Both halves
were confirmed by putting each bug back and watching them fail — the first
version of the browser half passed with the bug reintroduced, because a fake
request object is not an `IDBRequest` and `idb` never promisified it.

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

## A company's own geocoder

Under **More → Admin console → Settings → Address lookup**, a company can bring
their own geocoding account and choose which provider places their pins.

The reason is not cost, though it does move the bill to the people generating
it. It is that the vendors disagree about whether we may *keep* what they
return, and that disagreement is load-bearing here: this app writes a lead's
coordinates to D1 and to every phone and holds them for the life of the record,
because the map has to draw with no signal. Google and Radar permit caching for
about thirty days. Geocodio, LocationIQ, HERE and TomTom permit keeping them.
Mapbox, Smarty and Esri permit it conditionally, on a specific product or plan.

So the terms are carried in the registry next to each provider and stated on the
row next to the button that selects it — `Keeps coordinates`, `Conditional`,
`30 days only` — rather than left in documentation nobody reads before pasting a
key. A company choosing a thirty-day provider is choosing to carry that conflict
under their own contract, and the screen says so before they do.

A company's choice **replaces** the paid providers rather than joining them.
Falling back to our key when theirs misses would mean us paying for lookups the
screen has just told them they are paying for. Census stays underneath either
way, which is what keeps a deployment with no keys at all a working product.

Ten providers are listed. **Census is the default and needs no account at all**,
which is the property that matters most: a company that signed up this afternoon
gets working pins without talking to a vendor. Everything else is an upgrade
somebody chose.

Keys are stored **encrypted** under the same Worker secret as the CRM tokens
(`api/src/secretbox.ts`), in their own table rather than in
`client_integrations` — a geocoder key is not a CRM connection, has no outbox
draining against it, and putting the two in one table would mean every
integration listing had to remember to exclude it. One forgotten `WHERE` clause
is a customer's API key on a screen built for something else. No endpoint
returns a key: a saved provider shows a mask derived by decrypting and
re-masking on the server, and changing one means pasting a fresh one.

**A provider with no adapter is shown but cannot be connected.** The registry
distinguishes `live` from `planned`, the API refuses to store a key for a
`planned` provider, and the row says *Not connected yet*. The alternative is the
worst outcome this screen can produce: an operator who has been told they are
connected, and an import that quietly geocodes with something else. Adding an
adapter is a small isolated change; pretending one exists is not.

Every vendor host is unreachable from the build container, so no adapter can be
written or verified here from its own documentation — prices and terms in the
registry came from search results in August 2026 and are marked as orientation,
not as a quote.

```bash
npm run verify:geocoders
```

...also checks that the picker is *connected*. `activeGeocoderFor` shipped once
written, exported, covered by the screen and described here — and never called,
so a company could save a key, select a provider, be told they would be billed,
and have every import run on the deployment's keys anyway. A feature entirely
present except for being wired up, which testing the parts cannot find. The gate
now reads the endpoint that spends the money and insists it goes through the two
functions that make the choice real.

The rest runs in two halves. The registry half drives no browser and imports the
Worker's own registry rather than a copy, so it cannot pass against a
description that has drifted from the thing described: ids are unique, at least
one provider needs no account, every provider states its storage terms, and
Google and Radar are still marked temporary. The browser half asserts what a
customer sees — all ten listed, the thirty-day warning on its own row, an
unavailable provider offering no way to connect it, a masked key, and **no full
API key anywhere in the rendered page**. Both halves were proved by
reintroducing the bugs: relabelling Google as permanent, and returning a whole
key in the hint.

### The cost of a lookup, before the lookup

A company on their own geocoding key is billed by the vendor, per address, and
this app has no spend cap, no running total and no cut-off. The only thing
between an operator and an invoice they did not expect is knowing the number
before they press the button, so the address-lookup step says it.

The registry carries each provider's price twice: as prose for the row a human
reads, and as a number for the arithmetic. Parsing the prose to spend money
would have been worse, and `verify:geocoders` asserts the two agree — drift
between them is a screen that quotes one figure and bills against another.

`src/lib/spend.ts` does the sum, and three rules govern it.

**Never undershoot.** Where a vendor quotes a range the registry carries the top
of it, dollar figures round *up* to the cent, and the wording says an allowance
may already be partly spent — this app cannot see the vendor's meter. An
estimate that reads low produces exactly the surprise it exists to prevent.

**Never invent a number.** HERE and TomTom publish no simple per-thousand rate,
so those return `unknown` and the line says to check the account instead of
quoting a figure. A confident wrong number is worse than an honest gap, because
the operator stops checking.

**Say nothing when there is nothing to say.** On Census — free, no account, no
bill — the line does not render at all. That silence is what makes the warning
mean something on the third import rather than being scrolled past.

The estimate is arithmetic on data that already existed: the preview knows the
row count, the registry knows the price and the free tier. Nothing multiplied
them until now.

**A chargeable batch asks before it spends.** Past the free allowance the
one-click lookup is withheld and replaced by a confirmation carrying the figure
— *Look up anyway — about $12.40* — so the amount and the action are the same
button rather than a warning above a button that ignores it. Nothing reaches the
vendor until it is pressed.

**And it knows what has already gone.** Every batch sent on a company's key is
counted in `geocode_usage`, one row per client, provider and day, so the
allowance is measured as it stands rather than as it started. Without that, each
of three 1,000-address imports on a 2,500/day allowance reads as free while the
day quietly crosses the cap and nobody is warned on any of them.

The count is deliberately phrased as *what we have sent*, never *what you have
left*. The same key used from anywhere else adds to the vendor's total and not
to ours, and vendors reset on their own boundary — UTC for some, a billing month
for others — which this app cannot see. A floor we can stand behind beats a
remaining balance that would be wrong in the direction that costs money.

Deliberately a confirmation and not a cap. A ceiling this app enforced would be
guesswork dressed as a limit, for the same reason: it cannot see the vendor's
meter. What it can do is put the
decision in front of the person whose account is being billed, at the moment it
is billed. Inside the allowance nothing is interrupted at all — a prompt that
appears on every lookup is one people click through without reading, which would
make it worthless on the batch that actually costs money.

### Tables that were clipped rather than scrollable

Four of the console's screens were tables sitting inside `overflow-hidden`
cards. On a phone that does not produce overflow — the card simply cuts the
table off. Nothing is wider than the viewport, no pane pans, the document
measures clean, and the columns past the second do not exist as far as the
device is concerned. The Dashboard's was 622px in a 390px viewport with its last
column, "Closed", rendered at x=639.

Reports, Dashboard and Clients now render through `DataList`: cards at phone
width, the table kept on a desktop where comparing reps down a column is the
whole point of it. Settings' outcome editor scrolls horizontally instead —
that one is an editor rather than a data screen, its `#` column is the order
reps see, and cards would keep the data while losing the thing being edited.

`audit:viewports` now refuses the pattern, on **every** screen it measures — the
check runs from inside `checkOverflow` rather than beside it. It was first added
next to two of sixteen call sites, so the console was covered and the fourteen
field-app screens were not: the same shape as the bug it was written to find, a
rule that has to be remembered in sixteen places holding in two.

That also closed the reporting gap underneath all of this. `checkOverflow`
collects every element wider than the viewport, and only ever *reported* that
list when the document itself scrolled sideways — so an element that is too wide
and then clipped by a parent was silent by construction. The collection happened;
the reporting did not. It is why four clipped tables survived an audit that had
been running over those screens all along, and why they were eventually found by
reading instead.

Elements inside an `<svg>` are skipped. A path wider than its own `<svg>` is not
clipped content, it is how SVG works — the viewBox is a window onto a drawing
that is usually bigger than it, and the map's roads tripped this at three widths
on the first run.

Three mistakes were made writing that check, and the first two are the same
mistake in different places:

- It first compared a table against **its own** `clientWidth` and found nothing.
  A clipped table is laid out at its full natural width and is perfectly happy;
  `scrollWidth` equals `clientWidth`. Nothing overflows — the box is simply
  bigger than the hole it is shown through. It compares against the viewport now.
- It then walked **past** the clipping parent looking for any scroller, found
  the app's own `.scroll-pane` two levels up, and declared every one of these
  tables reachable. The walk stops at the first ancestor that is not `visible`,
  because whichever boundary is nearest is the one the content is trapped
  behind.

With all three fixed it names every offender at every width — verified by
planting a clipped element on Leads, a field-app screen that had no coverage at
all until the check moved inside `checkOverflow`.

That gap is closed too. The audit now opens a second context as the demo's
super admin and measures `/admin/clients`, which is how the table there should
have been found in the first place — it was found by reading, which is not a
system.

Closing it turned up something else. The pass, run deliberately as a client
admin to check it would notice, reported nothing: **`/admin/clients` had no role
check at all.** Its own docstring said "Super Admin only" and the console's nav
hides the entry, which hides the door without locking it — `AdminLayout` admits
managers and client admins, so typing the URL rendered the whole screen. Nothing
real leaked, because the figures on it are a hardcoded illustration; a company's
own admin seeing what looks like other customers' seat counts and revenue is
still wrong on its face, and it would have become a real leak the day that
screen is wired to an API. The screen enforces the role now.

The pass will not silently skip, either: it confirms it is actually on the
Clients screen before measuring, because a 403 renders a page that is narrow,
tidy and completely clean — which would report as a pass and quietly restore the
gap. That guard is what caught the missing role check.

### Who may call each API route

The console fix above was only cosmetic because the server refused those
requests anyway. That is the boundary that actually protects anything, so it
should not be the layer nobody has read end to end. Reading all 27 routes found
one that was open and should not have been.

**`/api/selftest/geocode` sat in front of authentication, took an arbitrary
address off the query string, and handed it to a paid geocoder.** Anyone with
curl could spend the deployment's Google quota in a loop, at list price. CORS
does not help — it is a browser rule and a script ignores it. `/api/selftest`
was open the same way and burns a password hash per call, which on a
per-CPU-second platform is its own small bill.

Both are diagnostics, and both are deliberately in front of sign-in: the
questions they answer — *is password hashing working on this deployment, does
the geocoder still parse an address the way it used to* — are exactly the ones
worth asking when nobody can sign in. So they are gated on `SETUP_TOKEN`, the
secret the first-run page already uses, held by exactly the people with reason
to run a diagnostic. A deployment with no token configured **refuses** rather
than defaulting open, because the deployment that forgot to set one is the one
least able to notice the bill.

```bash
npm run verify:api-access
```

...is a table, not a heuristic, and it covers **all three ways this router
matches a path**: an equality check, `path.startsWith(...)`, and a regular
expression. Every route names how it is guarded — `public`, `token`, `session`,
an inline `can*()` call, or a delegate that checks for itself — and **a route in
the source that is not in the table fails the gate.**

Three styles because the first two versions each missed one, and each time the
thing it had never looked at was the thing worth looking at. Version one knew
only about equality checks, printed "every API route has decided who may call
it", and had never seen `/api/users/:id/*` — the six most privileged operations
in the product: set a password, mint a reset link, change a role, deactivate,
delete. Version two learned about `startsWith` and still could not see
`/api/properties/:id/photos`, which is matched with a regex.

Those six turned out to be correctly guarded. Every one resolves its target
through a single `guard()` in `users.ts`, which requires `canInvite` unless you
are acting on your own account, loads the target scoped to the caller's own
company, refuses to let a lesser role act on a super admin, and answers **404
rather than 403** for another company's user so existence does not leak. Six
operations resting on one function makes it the highest-leverage thing on the
server, so the gate asserts those four properties individually rather than
trusting that a function called `guard` guards.
That is the part that matters: the point is not that every route is locked,
because several are deliberately open. It is that somebody decided and wrote the
decision down, since a forgotten route and a deliberately public one look
identical in code.

Delegates are read rather than trusted. A function that takes `user` looks
guarded from the call site whether or not it is, so the gate opens the file and
checks the function itself.

Proved by breaking it six ways: removing the diagnostics guard, adding an
undeclared route in each of the three matcher styles, stripping a role check out
of a delegate, and weakening `guard()` itself.

Two of those attempts initially reported a pass for the wrong reason, and both
are worth recording. One was a no-op edit — "the check did not fire" and "the
edit did not apply" look identical from outside, and only one means the check is
broken. The other was worse: the regex enumeration matched nothing, so *"every
regex route is declared"* passed on an empty array. A vacuous pass inside the
very check added to close the previous vacuous pass. The give-away was the
enumeration line naming two families and no regex route while a regex route
plainly existed — which is the argument for having checks print what they
found, not just whether they liked it.

### The console's role gate is one table, not nine screens

`NAV` in `AdminLayout.tsx` names which roles may see each section. It used to do
only that — *see*. The sidebar hid what a role should not have, and nothing
stopped anyone typing the URL: a manager could open the activity log and the
settings editor, and anybody who could reach the console at all could open the
platform Clients view. Its own docstring said "Super Admin only" the whole time.

The layout now derives both facts from the same list. A route in `NAV` is
navigable by exactly the roles it names, matched longest-prefix-first so
`/admin/settings` resolves to its own entry rather than to `/admin`, and
`/admin/team/:id` inherits Team's roles. No screen guards itself, which is the
point: a screen cannot forget to do something it does not do.

**What was actually exposed, stated plainly:** almost nothing. The server was
holding the whole time — `/api/audit` and every settings write check
`canInvite`, so a manager reached those screens and saw furniture with no rows
and an editor that would refuse to save. The Clients view was the real gap,
because it renders a hardcoded illustration and calls no API at all, so there
was no server check standing behind it. The lesson is not that data leaked; it
is that the UI told three different stories about who was allowed where.

`npm run verify:console` now navigates rather than reading the sidebar. For
every restricted route, each role that should not have it goes straight to the
URL and must be refused *visibly* and with none of the screen's content on the
page — both halves, because "refused" alone passes on a screen that renders its
furniture and shows nothing, and "not rendered" alone passes on a blank page.

That sweep is what found the two manager routes. The check that existed before
it asserted a manager could not *see* the Clients and Settings links, which is a
different claim from being unable to open them, and the difference is the whole
bug.

### Tap targets on the theme control

The three-way appearance control shipped at 32px per button. Three small glyphs
looked right and measured wrong: `audit:viewports` flagged them at every width
against this project's own 44px rule, and a rep changing theme outdoors in
gloves is exactly who that rule is for. They are 44px now, with the pill's own
padding removed so the group does not grow into the profile row beside it.

## Running the gates

```bash
npm run verify:all              # every gate
npm run verify:all -- theme     # only gates whose name contains "theme"
npm run verify:all -- --bail    # stop at the first failure
```

Not CI. Nothing schedules it, nothing triggers it on push, and it bills nobody —
it is the same by-hand suite that has always been here, with the two ways of
fooling yourself removed. Both cost a full run on the day it was written.

**A failed build leaves the last one on disk.** `npm run build` is
`tsc -b && vite build`, so a type error means Vite never runs and `dist/` still
holds the previous bundle. Every browser gate then tests code that is not the
code you just wrote — and passes. So the build runs first and a failure aborts
everything loudly, rather than scrolling past above a wall of green.

**A dead preview server looks like broken code.** When `vite preview` stopped
partway through a run, 28 browser gates failed with `ERR_CONNECTION_REFUSED` and
the summary read as 28 bugs. The only clue was that every pure-Node gate passed
— failures do not distribute that way. So the server is checked *before every
gate*, not once at the start, and if it stops the run ends naming the server
instead of producing a list of failures that are all the same failure.

It starts a preview server if none is running and stops that one afterwards. A
server you started yourself is left alone, because you are probably using it.

Both behaviours were tested rather than assumed: the build path by introducing a
type error, and the server path by running against a stand-in server stopped
mid-run, which reported the server and named the gate it stopped before.

## Before this goes to a paying customer

Deliberate compromises taken to keep the prototype moving. Each is fine for
building and testing and each is a real defect at launch, so they are written
down here rather than left in a chat log.

**[`LEGAL.md`](LEGAL.md) is the legal review list** — the five questions for
counsel, the facts behind each, and where data goes. Three of them were blockers
already; two were found by writing it.

**[`LAUNCH.md`](LAUNCH.md) is the checklist.** This section holds the reasoning —
what was measured, what was tried, why each compromise was taken. `LAUNCH.md`
holds the severity and the owner, and adds the items that were never written down
anywhere: the legal review that has no list, the backup key that has to be
generated before there is a production backup at all, and the question of whether
GHL sync is part of what customer one is buying. Read that
one to decide what to do next; read this one to understand why.

### What a rep does reaches the customer's CRM

The foundation — encrypted credentials, an id-link table, an outbox with dedupe
and backoff — was built first and then sat unused: `enqueue` had no callers and
nothing drained the queue. It was plumbing with no water in it. This is the
water.

**Queue on the way in, drain on the way out.** A rep completing a visit writes a
row and returns. Everything that can be slow or fail happens later, in a
scheduled drain, away from anyone standing on a doorstep.

The rule that shapes all of it: `queueForCrm` is called from inside `applyOne`,
and `applyMutations` treats a throw from there as the mutation being **rejected**
— it releases the idempotency claim and hands the phone an error. So a failure to
queue a CRM update would not lose a CRM update; it would tell a rep at a door
that their visit did not save, and the phone would retry the whole thing. Every
failure in that function is therefore swallowed and logged. The rep's work is the
product; the CRM copy is a convenience for the office.

**What is sent is state, not an event log.** Deduped per property, and the
payload carries only ids — the drain reads the lead at send time. A rep who
corrects an outcome three times costs the customer's API quota once, and the
correction that ships is the last one rather than the first.

**Do Not Contact travels outward,** and that is the case that matters most. A
household that told a rep to stop is only actually stopped if the office CRM
hears about it too — otherwise the rep honours it and the autodialler does not.

**Failures are sorted by who has to fix them.** A 500 or a rate limit retries with
backoff and does not mark the customer's connection broken, because flipping the
indicator every time GHL hiccups trains people to ignore it. A 401 or 403 does
mark it broken, because a human must fix the credential. A 400 fails that one row
and leaves the connection alone: we sent something they refused, which is our bug,
not their outage. Five attempts, then it stops and says so.

**Two ordinary cases are refused rather than retried.** A lead with no phone and
no email is dropped with a reason — GHL matches an upsert on one of those, and
sending anyway would create a fresh duplicate contact on every retry, which for a
door-to-door list is the common case rather than the edge one. And when two of
our properties share a phone number, GHL returns *one* contact for both;
`integration_links` is unique in both directions on purpose, so the second link
collides. The send succeeded, so the row is marked sent and carries a sentence
explaining that the link stayed with the lead that claimed it first. Before that
was handled, the raw `UNIQUE constraint failed` propagated, the row retried five
times against a condition waiting cannot change, and then failed in front of an
admin as a D1 error. **That bug was found by a reintroduction**, not by review:
removing the no-phone guard on purpose made two leads collide on one contact id.

#### The part that is not verified

`ghl.ts` says of itself that nothing in it invents an endpoint it has not been
able to check, and the request *shapes* for contacts were left out on those
grounds — GHL's documentation hosts are unreachable from this build environment
and still are.

`crm-push.ts` writes them anyway, from knowledge of their API rather than from
their docs, and says so where it sits. That is a departure from the standard the
file next to it sets, and it is called out rather than hidden. It is a contained
risk: a wrong shape produces a 4xx, a 4xx is permanent, and the row fails with
GHL's own words recorded against the customer's integration where an admin reads
them. Nothing is silently dropped and nothing is written incorrectly on their
side. **The first send against a real account is what turns this from probable
into known** — that is step 5 of connecting the live account, and it is the
reason that step exists.

#### Appointments are opt-in

GoHighLevel has no default calendar, so without a calendar id there is nowhere to
book an appointment. The first version of push queued one for every appointment
anyway, and the drain then failed each of them permanently — while the
Integrations screen, which reads the failed count and shows it in red, climbed
forever with nothing an admin could do about it. A customer who never wanted
appointment sync got a permanently broken-looking screen for a feature they had
not asked for.

So the calendar is a setting (`PUT /api/integrations/ghl/calendar`, and a field on
the Integrations screen), and **with no calendar set the app does not queue
appointments at all.** Silence is the honest answer to "we were not asked to do
this"; a red counter is not. Clearing the field is how a company turns appointment
sync off, and it removes the key rather than blanking it.

The subtler half: an appointment cannot be booked until the lead it belongs to
exists in GoHighLevel, and a rep booking at the door queues both in the same
batch — the contact upsert and the appointment. The drain takes them in
`next_attempt_at` order, so roughly half the time the appointment is reached
first and the contact is not linked yet. That used to be a permanent failure: an
appointment silently missing from the customer's calendar, for a condition that
one tick of waiting resolves. The plan a queued event resolves to now has three
outcomes rather than two — send, never, and **not yet** — and the ordinary retry
cap still stops a lead that genuinely never arrives.

#### Leads coming the other way

`POST /api/webhooks/ghl/<secret>` — above the authentication boundary, because
GoHighLevel has no Allstar login and never will.

**The URL is the credential.** A 64-character secret per company, rotatable, and
*that* is what decides whose data a payload touches. The body's `locationId` is
compared against the one on file as a sanity check and is never used to select a
tenant — every byte of a webhook body is controlled by whoever sent it, so
resolving a tenant from one would let anybody write leads into any company's
account by guessing an id. `verify:api-access` asserts this structurally: it finds
the variable the URL match is bound to and requires the tenant lookup to use that
variable's capture.

A signature would be better. GoHighLevel's documentation is unreachable from this
build environment, so rather than invent a signing scheme and give it the
appearance of verification, this uses the pattern that is correct for a vendor
that does not sign. If their signing is confirmed later it belongs alongside this,
not instead of it.

**Inbound leads are geocoded with the free Census geocoder and nothing else** —
never a paid key, even when the company has one and a rooftop pin would be better.
The guardrail on the import screen exists because this app does not spend a
customer's money without showing an estimate and having somebody agree to it, and
a webhook has nobody to ask. Wiring inbound leads to a paid provider would let a
stranger's traffic, or a bad month at GoHighLevel, bill a customer for lookups
nobody authorised. The cost is accepted and real: block-level precision instead of
rooftop, and a lead Census cannot place arrives unplaced and shows in the
console's unassigned count.

The property id is derived from the address, tenant-scoped, exactly as an import
derives it — so a lead arriving by webhook and the same address arriving in a CSV
are one row, and a replayed webhook updates rather than duplicating. A contact
with no street address is ignored outright: there is no door to knock on.

Everything it declines to act on answers 200. A webhook that returns an error gets
retried, and retrying a payload we have decided to ignore is load on both sides
with no outcome either way. Only a bad secret is refused, and without saying why.

`cd api && npm run smoke:crm-inbound` proves it against a real Worker, a real
database and a stand-in geocoder: the secret decides the tenant, a rotated secret
kills the old URL, a foreign `locationId` is refused, blanks fill and values do
not, a replay creates nothing, and a lead the geocoder cannot place is still
created and honestly reported as unplaced.

#### The rule for when both sides disagree

Decided ahead of the pull side being built, because it shapes what pull can do:
**Allstar wins, absolutely.** On any lead both systems know about, Allstar's copy
is authoritative for every field — status, visit outcome, Do Not Contact and
contact details alike. Nothing inbound is applied to a linked lead.

A split rule was proposed first — lead state to Allstar because the rep was at
the door, contact details to whichever side changed last on *event* time so an
office correction could stick — and rejected in favour of the simpler one. The
trade it accepts, stated because it will generate a support call: a correction
made in GoHighLevel is not merely ignored, it is **overwritten**. The old value
is still here and the next push writes it back. Corrections belong in Allstar.

Two things fall out of that, both good. There is no timestamp comparison
anywhere, so clock skew between two systems stops being a problem that has to be
tolerated. And pull loses its merge engine entirely: with no field-level
resolution to do, it collapses to *bringing in leads GoHighLevel has and Allstar
does not*, which have no local copy to disagree with.

Do Not Contact is the same rule with no exception: sticky, one-way, unreversible
by anything inbound.

**One carve-out, which is a case the rule never covered rather than an exception
to it: winning requires something to win with.** Where Allstar holds no value at
all, there is no disagreement — an empty phone number is not our position on what
the phone number is. `api/src/crm-merge.ts` decides that, `npm run verify:merge`
holds it, and it is a pure function so the rule can be reasoned about without a
webhook or a database in the way.

Fillable: a property's `city`, `state` and `zip`; a contact's `phone` and `email`;
and a contact row itself, where the property has none. Never fillable — and
*unexpressible* in the plan the function returns, which is a stronger guarantee
than refusing them at runtime: lead state, Do Not Contact, `address1` (the
identity of the lead; quietly moving one puts a rep at the wrong door), and
coordinates. Those last look fillable, because `lat`/`lng` are NOT NULL with a
default of `0` so an unplaced lead sits at 0,0 and reads as blank. They are
excluded anyway: coordinates are ours to derive, and taking theirs would bypass
the company's chosen geocoder, the spend estimate shown before a lookup runs, and
the storage-terms question in `LEGAL.md` question 4.

The case that pays for the whole file: a lead with no phone and no email cannot be
pushed at all, so an address-only row — the common shape in a door-to-door list —
is unsendable until something arrives. A phone number coming inbound is exactly
what turns it into a lead the office can work.

Proved by breaking it six ways, and the two that matter most are opposites: making
an inbound value overwrite one we already hold, and making the function fill
nothing at all. A merge that did nothing would pass every assertion about not
overwriting, which is why the gate asserts both directions.

The customer has to be told this before it bites them, and the note to send is
written out in `LAUNCH.md` item 11a.

#### Proving it

`cd api && npm run smoke:crm-push` — a real Worker, a real database, and a
GoHighLevel stand-in that records every byte we send, so the assertions are about
the request rather than the reply. It covers the auth and `Version` headers, the
sub-account, the address and phone, the id link, dedupe, and every failure mode
above.

Proved by breaking it eight ways: the queue failure rethrown into a rep's sync;
the enqueue removed; a 500 treated as permanent; every 4xx retried; the dedupe
key dropped; the id never linked; the no-phone guard removed; and a dead
credential no longer marking the connection broken.

Two of those runs were worth more than the other six. One found the collision bug
above. The other found that **three of my own assertions were vacuous**: the "GHL
is down" phase queued the address-only lead, which is dropped before any HTTP
happens, so the 500 was never reached and "a 500 does not mark the connection
broken" passed without a single request leaving the Worker. Every phase now
asserts what the stand-in actually received, not only what the database says
afterwards.

### Do Not Contact was recorded and not enforced

A rep can close a visit with **Do Not Contact**. It is terminal, it shows a ⊘, it
drops the property out of pipeline counts and out of route building. What it did
not do was stop the app offering to contact them.

`CommActions` built its own `tel:`, `sms:` and `mailto:` links and never read
`property.status`, so a household that had asked not to be contacted still showed
three working buttons — on the property screen, on the map's bottom sheet, and
inside Visit Mode. `PropertyRow` offered **swipe-left-to-call** from any list:
one gesture, no confirmation, also unchecked. Marking a household Do Not Contact
changed the reports and nothing else.

**Why the fix is not three patched call sites.** There were four paths to a live
`tel:`, and the swipe was added later by somebody who had no reason to know a
check existed. A fifth will be added. Patching the callers leaves the same trap
open.

So the check moved into the type. `smsHref` and `mailHref` are no longer exported
from `lib/format.ts`; they are private inside `lib/contact.ts`, and the only way
out of that module is `homeownerContact(property, contact)` — which takes the
property, and therefore the status that governs it. **There is no signature
anywhere in the app that produces a message or email link to a person without
that status coming along.** When contact is withdrawn the links are not built at
all rather than built and hidden, because a hidden `href` is one CSS mistake away
from being tappable.

`telHref` stays exported, because Team and Rep Detail call *colleagues*, who have
no lead status. `npm run verify:dnc` holds the three-file allowlist permitted to
import it, so reaching for the raw builder on a homeowner screen fails a gate.

The screen says *why* rather than showing three greyed-out buttons: a disabled
control there already means "no number on file", and a rep who reads it that way
goes hunting for the number somewhere else, which is the one outcome this exists
to prevent. **Navigate stays** — the block withdraws contact, it does not remove
the house from a route the rep is already walking.

**Three layers of check, and the middle one caught something the others could
not.** `verify:dnc` tests the rule as a function, the shape structurally, and the
screen in a browser with a real Do Not Contact property *that has a phone number*
plus a contactable control property — without that control, "no `tel:` links on
this page" passes just as happily on a build where the buttons were deleted
outright. Proved by breaking it seven ways. One of those — setting the blocked
flag but building the links anyway — was invisible to the browser, because the
component returns early on the flag and never renders them; only the direct test
of `homeownerContact` saw it.

**What this deliberately does not settle.** Suppression is per-property, where the
flag lives, while phone numbers live per-contact and a household can have several.
Whether Do Not Contact should attach to a person, a number or the address, whether
it survives a re-import of the same address, and whether a rep may reverse one are
questions for counsel — [`LEGAL.md`](LEGAL.md) question 2. This closed the gap
between what the app records and what it does; it did not pre-empt the answer.

### The MapTiler key allowed unknown origins — the code half is fixed

`Allowed HTTP Origins` on the MapTiler key includes `?`, which permits requests
that arrive with no `Origin` header.

It was there because the key had two incompatible jobs and the free plan allows
only one active key. The browser needs it origin-locked, because Vite compiles it
into the bundle where anyone can read it. The Worker needed it origin-free,
because a Worker sends no `Origin` and MapTiler rejects header-less requests when
any origin is listed. `?` satisfied both.

What it cost: another website embedding the key was still blocked, because a
browser always sends an `Origin`. A script or `curl` was not. Anyone who read the
key out of the JavaScript bundle could use it.

What that was worth: the free tier is a hard 100k/month cap with no overage
billing, so the worst case was the map going blank until the month rolled over —
an outage, not an invoice.

**Resolved by removing MapTiler from the geocoding chain**, which was the
Worker's only use for the key. The README used to offer two ways to close this:
move geocoding into the browser (~half a day) or pay for a plan with two keys.
Both were written before Google and Census covered geocoding on their own, and
both are now more work than the answer that was available: delete the third link.
MapTiler was already last in the chain because it guesses — asked about a house
it cannot resolve, it returns a fuzzy street match with the house number
discarded — so what is lost is a flagged street-level guess on addresses neither
Google nor Census can place. Those rows now come back unplaced, which is the
honest answer and, more usefully, the visible one.

The key is now browser-only, used for tiles through `VITE_MAPTILER_KEY`. That
means it can be fully origin-locked.

**Two steps remain, and both are Curtis's:**

1. **Rotate the key.** It appeared in a screenshot during a working session.
2. **Remove `?` from Allowed HTTP Origins** and list only the app's origins.
   Nothing sends a header-less request for a MapTiler resource any more.

Confirm afterwards with `/api/selftest/geocode` — its `attempts` array names the
provider that answered and the reason any provider refused. It should list
`google` and/or `census` and never MapTiler. `MAPTILER_API_KEY` on the Worker is
now unused; deleting that secret is safe.

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

This was meant to be fixed by geocoding with MapTiler, and was not — the
measurement below is why MapTiler was put last in the chain, and eventually why
it was taken out of it. Google now leads and returns a rooftop where it has one,
so this section describes the floor rather than the ceiling: what a pin looks
like on a deployment with no Google key, and on the addresses Google cannot
place.

What was measured, against two addresses from a live test list with the MapTiler
key working and the request correct:

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

**What it does establish** is the failure mode, and that outlived the provider.
Census answers an address it cannot resolve with a no-match. MapTiler answered
with a confident-looking street in the wrong ZIP. A wrong pin is worse than an
absent one, because an absent one is visible. That is why MapTiler went last, why
a guessed match never ends the search, and why the same rule now governs Google:
a `partial_match` is held as a fallback rather than accepted, and a state
centroid is refused outright.

`GET /api/selftest/geocode` geocodes a known address through the live chain and
reports every provider's attempt — which was asked, what it placed, and its own
words when it refused. The `?raw=1` variant and its tunable query parameters
went with the MapTiler adapter; they existed because MapTiler answered a house
with a street and the parsed output could not show why.

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
