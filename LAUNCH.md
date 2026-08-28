# Before a paying customer

One place for everything standing between this app and a customer paying for it.

It exists because that picture was spread across three sources that never met:
the task tracker, the README's *Before this goes to a paying customer* section,
and a handful of decisions that lived only in chat. Anything here that is not
also in the README is recorded here for the first time.

**Severity** is about what happens if it ships unresolved, not about effort.
**Owner** is who can actually move it — several of these cannot be closed by
writing code, which is the main thing this document is for.

The code itself is in good shape: 40 verification gates, all passing. Almost
nothing below is a coding problem.

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

Full reasoning: README → *Google's terms and the offline map are in direct
conflict*. The constraint is also recorded next to the code it governs, in
`api/src/geocode-google.ts` and `api/wrangler.toml`.

### 2. Backups are unencrypted
**Owner: me (code) + Curtis (where the key lives) · Severity: blocker**

`npm run backup` produces plain SQL holding every customer's addresses, contact
names and phone numbers, plus password hashes. `backups/` is git-ignored, so it
stays off GitHub — but the file is unencrypted the moment it is copied anywhere,
which is the entire point of having it.

The README already says the file "wants encrypting before it goes anywhere." That
sentence has been true and unactioned for a while.

### 3. Nothing runs a backup on a schedule
**Owner: Curtis · Severity: blocker · Tracked as #39**

The tooling exists and the restore has been drilled. The habit does not exist.
Until it does, the recovery window is Cloudflare Time Travel's thirty days.

Blocked on a decision, not on engineering: this needs either a scheduled job with
a Cloudflare API token, or a calendar reminder and a person. Which is appropriate
is a question about who holds that token.

### 4. The MapTiler key is exposed, and origin-unlocked by design
**Owner: Curtis (rotate) + me (close it properly) · Severity: blocker**

Two separate problems that resolve together.

*Exposed:* the browser key appeared in a screenshot during a working session. It
has not been rotated.

*Origin-unlocked:* `Allowed HTTP Origins` includes `?`, which permits requests
arriving with no `Origin` header. That is deliberate — the free plan allows one
key, the browser needs it origin-locked, and the Worker sends no `Origin` — but
it means anyone who reads the key out of the JavaScript bundle can use it from a
script or `curl`. Another website embedding it is still blocked; a script is not.

What it is worth today: the free tier is a hard 100k/month cap with no overage
billing, so the worst case is a blank map until the month rolls over — an outage,
not an invoice.

Preferred fix is to move geocoding into the browser (~half a day), which lets the
key be fully origin-locked and drops the Worker's need for one. Remove `?`
afterwards and confirm with `/api/selftest/geocode`.

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
that would have stopped it — see item 13.

### 6. DNC / TCPA review
**Owner: counsel · Severity: blocker · Not tracked anywhere until now**

The app stores phone numbers and reps contact people from it. The README assumes
a "DNC/TCPA review" exists as a thing that will happen; nothing has scoped one,
and no task tracks it.

Flagged here as an open question rather than an assessment — whether and how
these rules apply to this use is exactly what counsel is for.

### 7. Photo retention
**Owner: counsel + Curtis · Severity: blocker · Tracked as #18**

Reps photograph private property. There is no retention policy, no deletion path,
and no stated answer to how long the photos are kept or who can see them.

Task #18 says to put this on the legal review list. **There is no legal review
list.** Items 1, 6 and 7 are all waiting on the same conversation that has never
been scheduled — creating that list is probably the single highest-leverage thing
on this page.

---

## High — real defects, not blockers

### 8. Pins are block-level, not rooftop
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

### 9. Is GHL sync part of what the customer is buying?
**Owner: Curtis · Severity: high (product decision) · Tracked as #33–#37**

The foundation is built and merged (#33). Push (#34) and pull (#35) are not, and
#37 — connecting the live account — is paused at step 5.

This is on the list because its severity is entirely a product question. If the
first customer expects their leads to flow into GoHighLevel, this is a blocker.
If they don't, it is a roadmap item. Nobody has said which.

Note for when it resumes: #34 is blocked in this environment because GHL's
documentation is egress-blocked from the container, and #35 additionally needs a
decision on which side wins when both have changed a lead's pipeline stage.

---

## Medium

### 10. `react-router-dom` open redirect — a watch item, not a finding
**Owner: me · Severity: medium (today: none)**

An open redirect via a backslash in `<Link>`/`useNavigate`, advisory range
6.0.0–7.17.0. **Unreachable in this codebase**: every navigation target is an
internal literal path with an app-generated id interpolated, and nothing reads
`searchParams` to navigate. The fix is a semver major on the library the whole
app navigates through, for a bug the code cannot reach.

It becomes reachable the moment anyone adds a redirect parameter, a deep link
from an email, or navigation to a stored URL. That is the trigger to revisit, and
it is the sort of thing that arrives quietly.

### 11. `npm audit` — 11 findings, all development-only
**Owner: me · Severity: medium**

5 in the app, 6 in `api/`. All eleven were read and none are reachable in
production: `vite`/`esbuild` bite the dev server, `playwright` downloads browsers
this project never downloads, and the `wrangler` tree is not bundled into the
deployed Worker. Every available fix is a major upgrade, so nothing has been
bumped.

**The one habit worth keeping:** do not run `npm run dev` or `wrangler dev` in a
browser session that is also visiting untrusted sites. That is the whole exposure,
and it costs nothing to avoid.

### 12. Reporting history has not been rebuilt on production
**Owner: Curtis · Severity: medium · Tracked as #41**

Historical figures on the live account are still wrong until this runs. Use
`db:rebuild-stats` — **not** `db:rebuild-closed`.

### 13. Spend guardrail — the estimate is in, a running total is not
**Owner: me · Severity: medium · Tracked as #46 (partly done)**

**Done:** the address-lookup step states what the batch will cost before it runs
— the number of lookups, the provider being billed, the free allowance, and an
estimated charge when the batch exceeds it. Past the allowance the one-click
lookup is withheld and replaced by a confirmation carrying the figure, so
nothing reaches the vendor until someone agrees to be charged. Silent and
uninterrupted on a free provider, so the prompt still means something when it
appears. Rounds up, never quotes a figure for a volume-priced vendor, and says
an allowance may already be partly spent.

**Still missing:** a running lookup count, so nobody can see what has been spent
this day or month, and a ceiling an admin can set with a hard stop at it. Both
need usage tracking the app does not do yet, and neither can be inferred from
the vendor — this app cannot read their meter.

That gap is why **item 5 stays a blocker**. The estimate makes a surprise bill
much less likely; only a real total and a cap would make it impossible.

### 14. `ALLOWED_ORIGINS` rejects preview deployments
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

1. **Book the legal conversation.** Items 1, 6 and 7 all wait on it, and it is
   the only thing here where the calendar is the bottleneck rather than the work.
2. **Write the geocoding cost briefing** (item 5) before any company connects a
   key. Nothing in the app stops a surprise bill; right now that conversation is
   the only thing that does.
3. **Rotate the MapTiler key** (item 4). Minutes of dashboard work; something is
   currently exposed.
4. **Decide who holds a Cloudflare API token** (item 3), which unblocks scheduled
   backups.
5. **Say whether GHL is in scope for customer one** (item 9), which decides
   whether it is a blocker or a roadmap item.

Everything on that list is yours. While it moves, the code I can pick up without
input is backup encryption (item 2), moving geocoding into the browser (item 4),
and the `ALLOWED_ORIGINS` fix (item 14).
