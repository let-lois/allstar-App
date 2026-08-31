# Before a paying customer

One place for everything standing between this app and a customer paying for it.

It exists because that picture was spread across three sources that never met:
the task tracker, the README's *Before this goes to a paying customer* section,
and a handful of decisions that lived only in chat. Anything here that is not
also in the README is recorded here for the first time.

**Severity** is about what happens if it ships unresolved, not about effort.
**Owner** is who can actually move it — several of these cannot be closed by
writing code, which is the main thing this document is for.

The code itself is in good shape: 44 verification gates, all passing. Almost
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

### 7. Photo retention — and nothing in the product can delete anything
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

This is the largest engineering item behind the legal review, and it does not
exist in any form yet.

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

These are the customer's employees, not our users. Whether the notice obligation
is ours or the employing company's decides whether this is a code change or a
contract term, and that is a question for counsel rather than a defect.

---

## High — real defects, not blockers

### 10. Pins are block-level, not rooftop
**Owner: Curtis (pricing) + me (implementation) · Severity: high**

Every lead's pin is interpolated along a street, not placed on a building. A rep
gets the right block and the right side of the street; they do not get the right
house from the map alone.

MapTiler was supposed to fix this and does not — measured against two live test
addresses, it discarded the house number, matched the street, and ignored the
ZIP. That is why the geocoder chain puts Census first and MapTiler last: a wrong
pin is worse than an absent one, because an absent one is visible.

Closing it needs a provider with a US address-point database. **Geocodio** is the
candidate worth pricing — US/Canada only, rooftop-level, no requirement that
results be shown on the provider's map, cheap per thousand with a free daily
allowance.

**Until then: do not describe pins as rooftop-accurate to a customer.** The import
preview is already honest about it — a guessed match is flagged "close match —
check this one" — and that honesty is the mitigation.

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

**The conflict rule for #35 is decided (Curtis): the app has the last say.**
Split by who owns the field, because applied to every field it would mean the
office can never correct anything:

| | |
|---|---|
| Lead state — status, visit outcome, Do Not Contact | **Allstar always wins.** The rep was at the door. |
| Contact details — name, phone, email | Last write wins, on **event** time. |

"Event time, not arrival time" is the part that took a second pass. Comparing
when a change *arrived* gets the offline case backwards: a rep works a street
with no signal at 9am and syncs at 1pm, an office edit at 12:30 has a newer
arrival stamp, and the outcome from the person who was physically at the door
loses to someone who was not. The app already carries event time — mutations have
`createdAt` from the device and `visits.ended_at` is when the visit really ended —
so comparing those against GHL's `dateUpdated` keeps "last in wins" while making
the rep's presence count.

**Do Not Contact is sticky and one-way.** No inbound GHL change can un-DNC a
household, whatever the timestamps say. Everything else may flip freely.

### 11a. Tell the customer how sync conflicts resolve
**Owner: Curtis · Severity: high, once GHL sync is live · Tracked as #54**

Not a code item. The rule above is defensible and it will still surprise somebody
the first time it bites — an office manager edits a lead's stage in GoHighLevel,
a rep closes the same lead from a doorstep, and the office edit vanishes. That
conversation goes far better before it happens than after.

The note, ready to send:

> **How Allstar and GoHighLevel stay in step**
>
> Both systems can change the same lead, so there has to be a rule for when they
> disagree. Ours: **what the rep recorded at the door wins.**
>
> A lead's status, its visit outcome, and a Do Not Contact mark always come from
> Allstar. If someone moves a lead in GoHighLevel and a rep closes that same lead
> in the field, the rep's version is the one that stands — they were the person
> who was actually there.
>
> Contact details work the other way round: a name, phone number or email is
> whichever was **changed most recently**, from either system. So correcting a
> misspelled number in GoHighLevel sticks.
>
> "Most recently" means when the change was *made*, not when it reached us. Reps
> work in basements and dead zones and their phones sync hours later; without
> this, an office edit made at lunchtime would silently overwrite a doorstep
> outcome recorded that morning.
>
> One exception with no override: **Do Not Contact only ever travels outward.**
> Once a household has asked a rep to stop, nothing in GoHighLevel can undo that
> in Allstar. It is the one flag we will not let a sync reverse.

Also worth telling them at the same time: **connecting does not backfill.** Sync
starts from the moment the connection is made; leads already in either system do
not flow across on their own.

---

## Medium

### 12. `react-router-dom` open redirect — a watch item, not a finding
**Owner: me · Severity: medium (today: none)**

An open redirect via a backslash in `<Link>`/`useNavigate`, advisory range
6.0.0–7.17.0. **Unreachable in this codebase**: every navigation target is an
internal literal path with an app-generated id interpolated, and nothing reads
`searchParams` to navigate. The fix is a semver major on the library the whole
app navigates through, for a bug the code cannot reach.

It becomes reachable the moment anyone adds a redirect parameter, a deep link
from an email, or navigation to a stored URL. That is the trigger to revisit, and
it is the sort of thing that arrives quietly.

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

### 12b. Diagnostic endpoints were open to the internet — fixed
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
This is CORS working as designed, and the wildcard is not an option: it would let
any site on the internet drive this API with a rep's credentials. Allowing the
`*.allstar-app.pages.dev` suffix specifically would make previews testable before
merge.

---

## Low

| Item | Owner | Note |
| --- | --- | --- |
| iOS "Add to Home Screen" hint (#22) | me | Parked deliberately. |
| Reports, Import and Settings onto `DataList` | me | The last three screens rendering their own lists. Internal consistency only. |
| Per-client lead-score point weights | Curtis, then me | Needs a product decision on what the weights should be before it is codeable. |

---

## Closed by design — no action

Recorded so they are not re-raised.

**Rep location tracking.** Carried on an informal legal list for a while; it does
not belong there. There is no beacon and no breadcrumb trail. `RepDetail` shows
the last door a rep *logged* and when — a fact about the work, not about the
person. It goes stale the moment they stop logging and by construction says
nothing about anyone outside working activity. The screen states this in front of
the manager, and the rep sees the same screen about themselves. Nothing new is
collected to make it work.

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
