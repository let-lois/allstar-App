# Before a paying customer

One place for everything standing between this app and a customer paying for it.

It exists because that picture was spread across three sources that never met:
the task tracker, the README's *Before this goes to a paying customer* section,
and a handful of decisions that lived only in chat. Anything here that is not
also in the README is recorded here for the first time.

**Severity** is about what happens if it ships unresolved, not about effort.
**Owner** is who can actually move it — several of these cannot be closed by
writing code, which is the main thing this document is for.

The code itself is in good shape: **47 browser gates and 18 API tests**, each
with a runner — `npm run verify:all` and `cd api && npm run smoke:all` — and all
passing. Almost
nothing below is a coding problem — and the two blockers added most recently
(items 8 and 9) were found by writing a document, not by writing code.

---

## Blockers

Ship without resolving these and the exposure is legal, financial, or a customer
data loss. Roughly in the order they should be picked up.

### 1. Google's terms and permanent coordinate storage
**Owner: Curtis + counsel · Severity: blocker (conditional)**

Only live once `GOOGLE_MAPS_API_KEY` is set — and then, per the README, *the most
important item on the list.*

Google's Maps Platform terms permit only temporary caching of latitude and
longitude, on the order of thirty days. This app writes coordinates to D1 and to
every phone's IndexedDB and keeps them for the life of the record, because the
map has to draw with no signal. That is the product's founding requirement, so
this is not a bug in the code — it is a conflict between the offline requirement
and the provider's licence.

Three ways out, none free: get it reviewed by counsel and accept it; use Google
for display and a storable geocoder for storage; or store Place IDs and resolve
online, which costs the offline map entirely.

Scoped for counsel in [`LEGAL.md`](LEGAL.md) question 4, which is the version to
hand to a lawyer. Full engineering reasoning: README → *Google's terms and the
offline map are in direct conflict*. The constraint is also recorded next to the
code it governs, in `api/src/geocode-google.ts` and `api/wrangler.toml`.

### 2. Backups are encrypted — one command left, and it is yours
**Owner: Curtis (generate the key) · Severity: blocker until the key exists**

The code is done. `npm run backup` now writes AES-256-GCM
(`api/backups/*.sql.enc`), the restore drill decrypts on its own, and
`npm run verify:backups` holds it up. **It refuses to export production until a
key exists** rather than writing the plaintext — so right now there is no
production backup at all, which is why this is still a blocker.

Your part, once:

```bash
openssl rand -base64 32
```

Then either export it as `BACKUP_KEY` in the shell you run backups from, or save
it to `api/.backup-key` (git-ignored). Do not paste it into chat.

**Two things about that key.** It must go somewhere that is not the same disk as
the backups — a password manager. And it must never be lost: unlike
`INTEGRATION_KEY`, where a rotation costs every customer a reconnect, losing this
makes every backup written with it permanently unreadable. Keep old keys forever
rather than replacing them; a file from before a rotation still wants the key it
was written with.

Until it exists, the recovery window is Cloudflare Time Travel's thirty days —
which is the same position as item 3 below, for the same reason.

### 3. Nothing runs a backup on a schedule
**Owner: Curtis · Severity: blocker · Tracked as #39**

The tooling exists and the restore has been drilled. The habit does not exist.
Until it does, the recovery window is Cloudflare Time Travel's thirty days.

Blocked on a decision, not on engineering: this needs either a scheduled job with
a Cloudflare API token, or a calendar reminder and a person. Which is appropriate
is a question about who holds that token.

### 4. The MapTiler key is exposed — two console steps left, both yours
**Owner: Curtis · Severity: blocker until the key is rotated**

Two problems that resolved together. **The code half is done.**

*Origin-unlocked (fixed in code):* `Allowed HTTP Origins` includes `?`, which
permits requests arriving with no `Origin` header. That was deliberate — the free
plan allows one key, the browser needs it origin-locked, and the Worker sends no
`Origin` — but it meant anyone who read the key out of the JavaScript bundle
could use it from a script or `curl`. MapTiler has now been removed from the
geocoding chain, which was the Worker's only use for the key, so the key is
browser-only and can be fully origin-locked.

*Exposed (still open):* the browser key appeared in a screenshot during a working
session and has not been rotated.

**Your two steps, both in the MapTiler console:**

1. **Rotate the key**, and put the new one in `VITE_MAPTILER_KEY`.
2. **Remove `?` from Allowed HTTP Origins**, listing only the app's origins.

Then confirm with `/api/selftest/geocode` — `attempts` should name `google`
and/or `census` and never MapTiler. `MAPTILER_API_KEY` on the Worker is unused
now; deleting that secret is safe.

What it is worth until then: the free tier is a hard 100k/month cap with no
overage billing, so the worst case is a blank map until the month rolls over — an
outage, not an invoice.

**What the fix cost.** MapTiler was the third link in the geocoding chain and is
gone. It was already last because it guesses — asked about a house it cannot
resolve it returns a fuzzy street match with the house number discarded and the
ZIP ignored. Addresses neither Google nor Census can place now come back unplaced
instead of carrying a flagged street-level guess. That is the honest answer and
the visible one, but it is a real reduction in fallback coverage and is recorded
here rather than glossed.

### 5. Brief every company on geocoding cost before they connect a key
**Owner: Curtis · Severity: blocker · Tracked as #45**

Companies can now bring their own geocoding account under **More → Admin console
→ Settings → Address lookup**. The moment one does, **the vendor bills them
directly, per address, and Allstar has no spend cap, no budget alert and no
cut-off.** A large import can generate a real charge in an afternoon, and the
first anyone hears of it is the invoice.

Four things they have to hear before pasting a key:

1. **It is per address, not per month.** Every imported lead is one billable
   lookup. 50,000 leads on Google at $5/1,000 is roughly $250 in one sitting,
   past the 10,000/month free allowance. The same import on Geocodio is about
   $50 — or near nothing if spread across enough days to stay inside the
   2,500/day free tier.
2. **Free tiers are daily on some vendors and monthly on others.** Geocodio
   2,500/day, LocationIQ 5,000/day, Google 10,000/month, HERE 250,000/month. One
   big import can cross a daily cap partway through, leaving part of the batch
   geocoded and part not.
3. **Google and Radar cost twice.** Expensive per lookup, *and* both permit
   caching coordinates for only ~30 days — so compliance means re-geocoding the
   whole database every month, forever. That turns a one-time import cost into a
   subscription nobody budgeted for. The app shows "30 days only" on those rows;
   it does not explain the recurring bill that compliance implies.
4. **Their key, their liability.** If it leaks or is misconfigured, the charges
   are theirs. Pair this with the MapTiler lesson in item 4: anything compiled
   into a browser bundle is readable, so origin-lock it.

**What to advise:** stay on Census — free, no account, no bill — unless
block-level pins are actually costing them doors. If they upgrade, Geocodio is
the one that improves accuracy without the 30-day recurring trap.

This is a blocker because it cannot be fixed after the fact. A customer who
discovers a surprise bill from a vendor they were pointed at by us is a support
problem and a trust problem at the same time, and the app currently has nothing
that would have stopped it — see item 15.

### 6. DNC / TCPA review — the rules are counsel's; the defect is fixed
**Owner: counsel · Severity: blocker (the review) · Tracked as #50 (closed)**

Scoped in [`LEGAL.md`](LEGAL.md) question 2, with the facts counsel needs.

Preparing that brief turned up a defect, and **it is now fixed.** A rep could
close a visit with `do_not_contact` — terminal, marked ⊘, excluded from pipeline
counts and from route building — and the app went on offering one-tap Call, Text
and Email on that household from four separate places. `CommActions.tsx` never
read `property.status`; `PropertyRow.tsx` offered swipe-left-to-Call from any
list. Marking a household Do Not Contact changed the reports and nothing else.

The fix is not three patched call sites. One of those four paths was added later
by somebody with no reason to know a check existed, so the check moved into the
type: `smsHref` and `mailHref` are no longer exported from `format.ts`, they are
private inside `src/lib/contact.ts`, and the only way out of that module takes
the **property**. There is no signature anywhere that yields a message or email
link to a person without the status that governs them coming along. `telHref`
survives for Team and Rep Detail, which call colleagues, and `npm run verify:dnc`
holds the three-file allowlist permitted to import it.

**Still counsel's, and still a blocker:** whether Do Not Contact must attach to a
person, a phone number, or the address — it is per-property today while numbers
are per-contact; whether it survives the same address being re-imported in a
later list; whether a rep may reverse one; and the DNC-registry and TCPA
questions in `LEGAL.md`. The code no longer contradicts what it records, which is
a different thing from the rules being settled.

### 7. Photo retention — the deletion path now exists; how long to keep things does not
**Owner: counsel + Curtis · Severity: blocker · Tracked as #18**

Scoped in [`LEGAL.md`](LEGAL.md) question 3.

Task #18 said to put this on the legal review list, and **there was no legal
review list** — items 1, 6 and 7 were all waiting on the same conversation, which
made creating that list the highest-leverage thing on this page. It now exists as
[`LEGAL.md`](LEGAL.md): five questions, the verifiable facts behind each, and a
sub-processor table. A shareable version is published as an artifact.

Writing it turned up something worse than "no retention policy." Every
`DELETE FROM` in `api/src/` was enumerated: deletions exist for config rows,
sessions, rate-limit counters, route stops and users, and **nothing deletes a
photo, property, contact, note, visit or activity record.** There is no
data-subject deletion path in the product at all, and nothing expires on a
schedule. Copies of photos also persist in each rep's phone storage, outside any
server-side deletion.

**The machinery now exists (task #53).** `DELETE /api/leads/erase` erases a lead
and everything hanging off it — contacts, notes, visits, photo rows and files,
appointments, tasks, activity — takes a required reason, records the act in the
audit log with the address it had, and writes a tombstone so the address cannot
come back. That last part matters more than it looks: a property's id is derived
from its address, so without it the next CSV or the next GoHighLevel webhook would
recreate the lead and undo the erasure with nobody noticing. Narrower permission
than importing: owner and above, not managers. Proved by `npm run smoke:erase`.

**The copies on reps' phones now go too (task #56).** Every device holds a full
offline copy by design, and deleting server-side does not touch it — so the
erased ids ride out on `/api/bootstrap` and each device purges its own copies.
The stores that matter are the three bootstrap never returns: visits, notes and
photographs. Those are deliberately never replaced by a refresh, so a rep's own
work cannot vanish under them — which also meant nothing in an ordinary refresh
could ever have removed one, however long the lead had been erased. The
photograph is the row, so deleting the row is deleting the picture.

Two things came out of building it. A phone could **undo an erasure**: a queued
"new lead at the door" mutation is an INSERT, and the sync path had no tombstone
check where the CSV and webhook paths both did — so the address came back under
the same derived id with nobody told. That is closed, and queued work for an
erased lead is now discarded rather than refused, so it does not sit in an outbox
retrying forever. Proved by `npm run smoke:erase` and, in a real browser against
a real IndexedDB, `npm run verify:erasure-reach`.

**Still deliberately not built: scheduled retention expiry.** How long
photographs of private property may be kept is exactly what question 3 asks
counsel. Picking a number now means writing it
twice, so nothing expires on a schedule yet.

Backups are unchanged and unchangeable: every encrypted dump still holds the
erased lead, and nobody rewrites backups. Whether "erased going forward" satisfies
a request is counsel's, not ours.

### 8. Personal data about people who never agreed to anything
**Owner: counsel · Severity: blocker · Tracked as #51 · Not recorded until now**

Scoped in [`LEGAL.md`](LEGAL.md) question 1.

The database holds, about homeowners who never signed up for anything: street
address and precise coordinates, plus `owner_occupied`, `roof_age_years`,
`square_feet`, a dollar `opportunity_value` and a lead `score`; a contact's name,
phone, email and relationship to the property; and `notes.body`, free text a rep
types about the household with no structure and no restriction on what goes in
it. Records arrive by CSV from lists the customer supplies, and we do not know
how those lists were assembled.

There is no consent field, no list-provenance field, and no lawful-basis field.

Found while preparing the counsel brief. It had not been written down anywhere,
which is the argument for having written that brief: two of the five legal
blockers had never been articulated.

### 9. The app also tracks the reps using it
**Owner: counsel · Severity: blocker · Tracked as #52 · Not recorded until now**

Scoped in [`LEGAL.md`](LEGAL.md) question 5.

`visits` records `start_lat`, `start_lng` and `start_accuracy` — where the rep
physically was when each visit began. Every photo is geotagged. `daily_stats`
holds per-rep daily knocks, conversations, appointments, quotes, sales and
pipeline value; `activity` logs individual actions; a leaderboard ranks reps
against each other.

Location is requested once per session rather than tracked continuously (#28), so
there is no movement trail — but nothing tells a rep their position is recorded
and there is no way to decline.

**What is genuinely mitigating, and counsel should hear it too.** There is no
beacon and no breadcrumb: a position is stored when a rep logs a visit and at no
other time, so the record is silent about anyone outside working activity and
goes stale the moment they stop logging. `RepDetail` shows a manager the last
door a rep logged and when — a fact about the work — and the rep sees the same
screen about themselves. Nothing is collected solely to enable the monitoring.

This was, for a while, filed under "closed by design — no action" on exactly that
reasoning. It was reopened when the schema was enumerated for `LEGAL.md`, because
"no continuous tracking" and "we store the employee's GPS position at each visit
and never mention it" are both true, and only the first had been written down.

These are the customer's employees, not our users. Whether the notice obligation
is ours or the employing company's decides whether this is a code change or a
contract term, and that is a question for counsel rather than a defect.

---

## High — real defects, not blockers

### 10. Pins are block-level, not rooftop
**Owner: Curtis (pricing) · Severity: high · the implementation half is done**

A lead placed by the Census geocoder is interpolated along a street rather than
put on a building. A rep gets the right block and the right side of the street;
they do not get the right house from the map alone. Google, when a key is
configured, does return rooftops — so this is a per-lead property, not a
property of the product.

**Fixed: the app no longer hides which is which.** The geocoders had always
reported precision per address and the import preview had always shown it, and it
was dropped on the way into the database — so a lead's row lost the distinction
and the map drew an estimate with exactly the confidence of a rooftop. It is now
stored (`properties.geo_precision`, migration 012), sent to the phone, and shown:
an estimated pin is hollow with a dashed ring, and the lead screen says *"Pin is
estimated from the street — check the house number before you knock"* next to the
Street View image a rep would use to settle it. Null means *unknown*, not
approximate — leads imported before this existed are not accused of being wrong.
Gated by `npm run verify:pin-precision` and the precision cases in
`smoke:import`.

**Not fixed, and it needs a decision rather than code:** making every pin rooftop
requires a provider with a US address-point database.

| | Rooftop | Price | Storage | Adapter |
| --- | --- | --- | --- | --- |
| **Census** (current fallback) | No — interpolated | Free | Permanent | Live |
| **Google** | Yes, almost everywhere | $5.00/1,000 | **~30 days only** — conflicts with offline-first | Live |
| **Geocodio** | Yes, most US addresses | $1.00/1,000, 2,500/day free | **Permanent, permitted** | **Not written** |

Geocodio is the better fit and the recommendation: a fifth of Google's price and
it is the only rooftop option whose terms allow keeping coordinates permanently,
which is what an offline-first app actually needs. Google's 30-day caching limit
is already recorded as a conflict this app knowingly violates on the customer's
own account.

Its adapter does not exist yet (task #44) and **cannot be built or tested from
the current dev environment** — `api.geocod.io` is refused by the network policy,
so there is no way to verify a response format against the real service from
here. That is a genuine blocker on that specific piece of work, not a preference.

**Until a rooftop provider is connected: do not describe pins as rooftop-accurate
to a customer.** The mitigation is now in the product rather than only in the
import preview — the map and the lead screen both say when a pin is a guess.

### 11. Is GHL sync part of what the customer is buying?
**Owner: Curtis · Severity: high (product decision) · Tracked as #33–#37**

The foundation is built and merged (#33). **Push (#34) is now built too**: a
rep's outcome queues, a scheduled drain sends it, and `npm run smoke:crm-push`
holds the whole path up against a real Worker and a GoHighLevel stand-in. Pull
(#35) is not built, and #37 — connecting the live account — is still paused at
step 5.

This is on the list because its severity is entirely a product question. If the
first customer expects their leads to flow into GoHighLevel, this is a blocker.
If they don't, it is a roadmap item. Nobody has said which.

**One thing to know before the first live send.** GHL's documentation hosts are
still egress-blocked from the build container, so the contact request *shape* in
`crm-push.ts` is written from knowledge of their API rather than from their docs,
and is marked as such in the file. Everything around it — the transport, the auth,
the retry rules, the queue — is verified. If the shape is wrong, GHL answers 4xx,
the row fails permanently with their own words recorded against the customer's
integration, and nothing is written incorrectly on their side. **Step 5 of #37 is
what settles it**, and it is now the cheapest way to settle it.

**Pull is built (#35).** `POST /api/webhooks/ghl/<secret>` receives contacts,
creates leads, and fills blanks under the rule below. The URL is the credential —
a 64-character secret per company, rotatable from the Integrations screen — and
that secret, never the payload, decides whose data a webhook touches. Inbound
leads are geocoded with the free Census geocoder only, never a paid key, because a
webhook has nobody to show a spend estimate to; the cost is block-level precision
rather than rooftop. Proved by `npm run smoke:crm-inbound`.

Still not built and undecided: **no backfill in either direction.** Sync starts at
the moment of connection, and leads already sitting in either system do not flow
across. Worth telling the customer at the same time as the conflict rule.

**The conflict rule for #35 is decided (Curtis): Allstar wins, absolutely.**

Not split by field. On any lead the two systems both know about, **Allstar's copy
is authoritative for every field** — status, visit outcome, Do Not Contact, and
contact details alike. An inbound GoHighLevel change to a linked lead is never
applied.

This was proposed first as a split — lead state to Allstar, contact details to
whichever changed last — and rejected in favour of the simpler rule. The trade
was stated before it was taken and is worth restating here, because it is the
part that will generate a support call:

> **A correction made in GoHighLevel does not merely fail to arrive — it gets
> overwritten.** Someone fixes a misspelled phone number over there; Allstar
> still holds the old one, and the next push writes the old one back over the
> fix. Corrections have to be made in Allstar.

**Do Not Contact** is the same rule with no exception anywhere: sticky, one-way,
and no inbound change may reverse it. Consistent with `LEGAL.md` question 2.

**What this does to #35.** It removes the merge engine. With no field-level
resolution to perform, pull collapses to one useful job: **bringing in leads that
exist in GoHighLevel and not in Allstar.** Those have no local copy to conflict
with, so they simply arrive. Everything else inbound is recorded and ignored.
Smaller to build, far smaller to get wrong, and there is no timestamp comparison
anywhere — which also disposes of clock skew between the two systems.

**The one carve-out, now decided and built.** Winning requires something to win
with. Where Allstar holds no value at all for a field, there is no disagreement
to resolve — an empty phone number is not our position on what the phone number
is. So a blank is filled and a value is never replaced.

`api/src/crm-merge.ts` is that rule as a pure function, and
`npm run verify:merge` holds it. Fillable: a property's `city`, `state`, `zip`;
a contact's `phone` and `email`; and a contact row itself where the property has
none. Never fillable, and unreachable from the plan the function returns rather
than merely refused by it: lead state, Do Not Contact, `address1`, and
coordinates — those last are ours to geocode, and taking GoHighLevel's would
bypass the company's chosen provider, the spend estimate shown before a lookup,
and the storage-terms question in `LEGAL.md` question 4.

The case this pays for: a lead with no phone and no email **cannot be pushed at
all** — GoHighLevel matches an upsert on one of those — so an address-only row,
which door-to-door lists are full of, is unsendable until something arrives. A
phone number coming the other way is what makes it sendable.

**Appointments are opt-in, and were briefly broken.** GoHighLevel has no default
calendar, so without an id there is nowhere to book. Push shipped queueing an
`appointment.create` for every appointment regardless — which then failed
permanently with "no calendar is configured", and the Integrations screen reads
the failed count and shows it in red. A customer who simply did not want their
appointments synced would have watched that number climb forever with no action
available that would clear it.

Fixed three ways, tracked as #55: a **Calendar ID** field on the Integrations
screen; no queueing at all when it is empty, because silence is the honest answer
to "we were not asked to do this"; and a third drain outcome so an appointment
queued ahead of its own lead **waits** instead of failing. That last one was the
subtler half — a rep booking at the door queues the contact upsert and the
appointment together, and the drain takes them in order, so roughly half the time
the appointment was reached first and died for a condition one tick of waiting
resolves.

### 11a. Tell the customer how sync conflicts resolve
**Owner: Curtis · Severity: high, once GHL sync is live · Tracked as #54**

Not a code item. The rule above is defensible and it will still surprise somebody
the first time it bites — an office manager edits a lead's stage in GoHighLevel,
a rep closes the same lead from a doorstep, and the office edit vanishes. That
conversation goes far better before it happens than after.

The note, ready to send:

> **How Allstar and GoHighLevel stay in step**
>
> Both systems can hold the same lead, so there has to be a rule for when they
> disagree. Ours is deliberately simple: **Allstar is the record.**
>
> For any lead both systems know about, what is in Allstar wins — its status, the
> outcome a rep recorded at the door, a Do Not Contact mark, and its contact
> details too. Allstar pushes its version to GoHighLevel; GoHighLevel does not
> push back.
>
> **The part to plan around:** editing one of those leads in GoHighLevel will not
> hold. If you correct a phone number there, Allstar still has the old one, and
> the next time a rep touches that lead the old number is written back over your
> correction. It will look like the edit was undone, because it was.
>
> **So make corrections in Allstar.** They flow outward from there, and they
> stick.
>
> Leads that exist only in GoHighLevel are a different case — there is nothing in
> Allstar to disagree with, so they come across normally.
>
> There is one more case where GoHighLevel does reach us: **a field Allstar has
> never had a value for.** If a lead is in Allstar with no phone number and
> GoHighLevel has one, we take it — there is nothing of ours to disagree with, and
> a lead we can reach is worth more than one we cannot. Filling a gap is not the
> same as changing an answer.
>
> One rule with no exception: **Do Not Contact only ever travels outward.** Once a
> household has asked a rep to stop, nothing in GoHighLevel can undo that in
> Allstar.

Also worth telling them at the same time: **connecting does not backfill.** Sync
starts from the moment the connection is made; leads already in either system do
not flow across on their own.

**One paragraph to add to that note now that the flagging is built:**

> When a rep has been out of signal for days, their work can land on a lead
> somebody moved in the meantime. Their answer still wins — they were at the
> door. But the console now says so: the dashboard lists those leads for a
> manager, with the rep's name and how late the work arrived, so somebody can
> make the call instead of finding out from the homeowner. Nothing to approve
> or undo; it is a short list of people worth ringing.

---

## Medium

### 12. `react-router-dom` open redirect — a watch item, not a finding
**Owner: me · Severity: medium (today: none)**

An open redirect via a backslash in `<Link>`/`useNavigate`, advisory range
6.0.0–7.17.0. **Unreachable in this codebase**: every navigation target is an
internal literal path with an app-generated id interpolated, and nothing
navigates to a value read out of the URL. The fix is a semver major on the
library the whole app navigates through, for a bug the code cannot reach.

The wording above used to say "nothing reads `searchParams`", which is no longer
true — the Leads screen reads `?q=` so the sync-conflict panel can send a manager
there pointed at one house. That value seeds a *search box*, never a navigation
target, so the advisory is still out of reach. Recorded here rather than quietly
reworded, because it is one step closer than it was.

It becomes reachable the moment anyone adds a redirect parameter, a deep link
from an email, or navigation to a stored URL. That is the trigger to revisit, and
it is the sort of thing that arrives quietly.

### 12a. Diagnostic endpoints were open to the internet — fixed
**Owner: me · Severity: was a blocker · Tracked as #47**

`/api/selftest/geocode` sat in front of authentication, accepted an arbitrary
address, and handed it to a paid geocoder — so anyone with curl could spend the
deployment's Google quota in a loop at $5/1,000. `/api/selftest` was open the
same way and burns a password hash per call.

Both now require `SETUP_TOKEN`, and refuse outright on a deployment that has not
set one. `npm run verify:api-access` holds all 27 routes to a declared access
level, and fails on any route that does not name one.

The sweep also covered the six `/api/users/:id/*` operations — set password,
reset link, role change, deactivate, delete, footprint — which the first version
of the gate had never looked at. All six are correctly guarded: one shared
`guard()` requires admin rights, scopes the target to the caller's own company,
blocks a lesser role acting on a super admin, and returns 404 rather than 403 so
another company's user existence does not leak.

**Nothing to do — listed because it was live.** If that endpoint was ever hit by
anything other than us, it would show as geocoding spend with no matching
import. Worth a glance at the Google console for the last week.

### 13. `npm audit` — 11 findings, all development-only
**Owner: me · Severity: medium**

5 in the app, 6 in `api/`. All eleven were read and none are reachable in
production: `vite`/`esbuild` bite the dev server, `playwright` downloads browsers
this project never downloads, and the `wrangler` tree is not bundled into the
deployed Worker. Every available fix is a major upgrade, so nothing has been
bumped.

**The one habit worth keeping:** do not run `npm run dev` or `wrangler dev` in a
browser session that is also visiting untrusted sites. That is the whole exposure,
and it costs nothing to avoid.

### 14. Reporting history has not been rebuilt on production
**Owner: Curtis · Severity: medium · Tracked as #41**

Historical figures on the live account are still wrong until this runs. Use
`db:rebuild-stats` — **not** `db:rebuild-closed`.


### 15. Spend guardrail — the estimate is in, a running total is not
**Owner: me · Severity: medium · Tracked as #46 (partly done)**

**Done:** the address-lookup step states what the batch will cost before it runs
— the number of lookups, the provider being billed, the free allowance, and an
estimated charge when the batch exceeds it. Past the allowance the one-click
lookup is withheld and replaced by a confirmation carrying the figure, so
nothing reaches the vendor until someone agrees to be charged. Silent and
uninterrupted on a free provider, so the prompt still means something when it
appears. Rounds up, never quotes a figure for a volume-priced vendor, and says
an allowance may already be partly spent.

**Also done:** every batch sent on a company's key is now counted, so the
allowance is measured as it stands rather than as it started — three 1,000-row
imports against a 2,500/day tier no longer each read as free while the day
crosses the cap. And the picker is now actually wired to the geocoder: it
shipped in the previous PR without being connected, so a company could select a
provider, be told they would be billed for it, and have every import run on the
deployment's keys instead.

**Still missing:** a ceiling an admin can set with a hard stop at it. Not built,
and arguably should not be — any limit this app enforced would be guesswork,
because it cannot see the vendor's meter and its own count is a floor rather
than a total.

**Item 5 stays a blocker** regardless. The app now warns accurately about what
it can see; it cannot see the same key being used from somewhere else, and no
amount of code changes that. The briefing is what covers the rest.

### 16. `ALLOWED_ORIGINS` rejects preview deployments
**Owner: me · Severity: medium (friction)**

CORS is an exact match, so per-deployment Pages hostnames — the hashed
`*.allstar-app.pages.dev` URLs — are always rejected and sign-in fails on them.
This is CORS working as designed.

The wildcard is still not the answer, but **not for the reason this document
used to give.** It said a wildcard "would let any site on the internet drive this
API with a rep's credentials" — that is the cookie-authentication argument, and
this API is `Authorization: Bearer` with no cookies anywhere. A browser never
attaches a rep's credential to a request from somebody else's page, and
cross-origin script cannot read the token out of this app's storage. A wildcard
would not hand anyone a session.

What it would actually cost: everything reachable *without* a token becomes
readable by any page on the internet, and the blast radius grows the day
authentication changes shape. Worth keeping correct; not worth the sentence that
was there.

Allowing the `*.allstar-app.pages.dev` suffix specifically would make previews
testable before merge, and is the fix if this is ever worth doing.

---

## Low

| Item | Owner | Note |
| --- | --- | --- |
| iOS "Add to Home Screen" hint (#22) | me | Parked deliberately. |
| Reports, Import and Settings onto `DataList` | me | **Mostly moot.** Reports is done. Import's preview table and Settings' key/value panels are not really lists, so converting them buys nothing — rewritten here rather than left reading as pending work. |
| Per-client lead-score point weights | Curtis, then me | Needs a product decision on what the weights should be before it is codeable. |

---

## Closed by design — no action

Recorded so they are not re-raised.

**A CAPTCHA on the login screen.** Considered and declined, August 2026.

`api/src/ratelimit.ts` already holds two buckets — 8 failed attempts per email
and 40 per IP in a 15-minute window — checked *before* password hashing, so a
guess already decided against costs no CPU. That stops someone grinding one
account and someone spraying one password from one address.

The gap a CAPTCHA would close is distributed credential stuffing: many addresses,
each trying a few emails a few times, slipping under both buckets. Real, but not
the threat this app faces — a handful of accounts per company, no consumer
signup, nothing worth a botnet.

Against that: a rep signs in outdoors, one-handed, in sunlight, on bad
connectivity. Cloudflare Turnstile is the right choice if this is ever revisited
— already our platform, no new sub-processor, usually invisible — but it needs a
network round trip before the form can be submitted, and on a poor connection or
an odd-looking IP it becomes an interactive challenge. That is a new way for the
one screen that must work to fail, aimed squarely at the user everything else
here is built around.

**Revisit if:** actual attack traffic appears, or a customer's procurement asks
for one. If it is built, it must fail open — no Turnstile, no verification, let
the attempt through and lean on the rate limiter, exactly as the limiter itself
already fails open.

**Rep location tracking — REOPENED, see item 9.** This entry used to say the
question did not belong on a legal list: no beacon, no breadcrumb trail, and
`RepDetail` showing the last door a rep *logged* is a fact about the work rather
than about the person. All of that is still true and still worth knowing.

It was written before anybody enumerated the columns. `visits` stores
`start_lat`, `start_lng` and `start_accuracy` — the rep's GPS position at each
visit — `photos` carries `captured_lat`/`captured_lng`, and `daily_stats` holds
per-rep daily performance. A stored position per visit is not a breadcrumb trail,
but it is not nothing either, and nothing in the app tells a rep it is recorded or
offers a way to decline.

So the question is live again as item 9 and `LEGAL.md` question 5, with the
mitigating facts above carried into it: there is no continuous tracking, and the
rep sees the same screen about themselves that a manager sees. Two entries in one
document disagreeing about a legal item is worse than either answer, which is why
this says so rather than being deleted.

---

## What to do first

1. **Book the legal conversation.** Now items 1, 6, 7, 8 and 9 — five of the nine
   blockers — and it is the only thing here where the calendar is the bottleneck
   rather than the work. The brief is written: [`LEGAL.md`](LEGAL.md) has the
   five questions, the facts behind each one and a sub-processor table, and a
   shareable version is published as an artifact. Nothing is waiting on
   preparation any more.
2. **Write the geocoding cost briefing** (item 5) before any company connects a
   key. Nothing in the app stops a surprise bill; right now that conversation is
   the only thing that does.
3. **Rotate the MapTiler key and remove `?` from its Allowed HTTP Origins**
   (item 4). Minutes of dashboard work; something is currently exposed, and the
   code change that lets the key be locked down is already in.
4. **Decide who holds a Cloudflare API token** (item 3), which unblocks scheduled
   backups.
5. **Say whether GHL is in scope for customer one** (item 11), which decides
   whether it is a blocker or a roadmap item.

Add to that list, now that the code is done: **generate the backup key** (item
2). One `openssl` command, and until it happens there is no production backup at
all.

Everything on that list is yours. The engineering behind items 2 and 4 is now
done, so both are waiting on a console step rather than on code.

The Do Not Contact enforcement defect (item 6) is done. The only thing left that
I can pick up without input is the `ALLOWED_ORIGINS` fix (item 16).

Writing the counsel brief also found the two new blockers, items 8 and 9. Neither
had been recorded anywhere. That is the argument for having written it.
