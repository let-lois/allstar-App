# The legal review list

`LAUNCH.md` said, for a while, that items 1, 6 and 7 were "all waiting on the same
conversation that has never been scheduled" and that "there is no legal review
list." This is that list.

It exists so the conversation with counsel can happen once, with the facts in
hand, instead of three times with someone reconstructing the schema from memory
each time.

**Scope.** Nothing here is a legal conclusion and no view is offered on whether
any obligation applies — that is what counsel is for. Where a judgement about the
code appears it is labelled as an engineering opinion. Every factual claim names
the file or table it came from, so counsel's questions can be checked against the
code rather than against this document.

**A shareable version of this brief** is published as an artifact for handing to
a lawyer. This file is the engineering-side record: same five questions, more
file paths.

---

## The five questions

| | Question | First recorded | Code defect attached |
| --- | --- | --- | --- |
| 1 | Personal data about people who never agreed to anything | This sweep | — |
| 2 | Do Not Contact — rules unsettled | `LAUNCH.md` item 6 | Fixed (task #50) |
| 3 | Photographs kept forever, deletable by nobody | `LAUNCH.md` item 7 / task #53 | **Yes** |
| 4 | Google's licence terms against an offline map | `LAUNCH.md` item 1 | — |
| 5 | The app also tracks the people using it | This sweep | — |

Questions 1 and 5 were not written down anywhere before. They came out of a
review of `api/schema.sql` and the app's contact components carried out to
prepare this list, which is the argument for having written it: two of five
blockers in this area had never been articulated.

---

### 1. Personal data about people who never agreed to anything

**Where it lives.** `api/schema.sql`:

- `properties` — `address1`, `city`, `state`, `zip`, `lat`, `lng`, plus inferred
  attributes: `owner_occupied`, `roof_age_years`, `square_feet`,
  `opportunity_value`, `score`
- `contacts` — `name`, `phone`, `email`, `relationship`
- `notes` — `body`, free text typed by a rep about the household, unstructured
  and unrestricted

Records arrive by CSV import from lists the customer supplies. We do not know how
those lists were assembled.

**What the code does.** No consent field, no list-provenance field, no
lawful-basis field. Tenant isolation is enforced on every API route — swept and
gated by `npm run verify:api-access`.

**For counsel.** Whether notice or consent attaches; whether list provenance must
be recorded and imports refused without it; whether the inferred property
attributes or the free-text notes create obligations beyond address and phone;
and whether the obligation is ours, the customer's, or shared — which decides
whether this is code or contract.

---

### 2. Do Not Contact is recorded and not enforced

**What exists.** `src/data/outcomes.ts` defines `do_not_contact` as a terminal
outcome with a ⊘ marker. `src/admin/useAdminData.ts` excludes `dnc` properties
from pipeline and open-lead counts.

**The defect, since fixed.** `CommActions.tsx` rendered one-tap Call, Text and
Email and **never read `property.status`** — on `PropertyDetail`, the map's
`PropertyPeek` bottom sheet and `VisitMode` — and `PropertyRow.tsx` offered
**swipe-left-to-Call** from any list, also unchecked. Marking a household Do Not
Contact changed the reports and nothing about the app's ability to contact them.

Contact links now come only from `src/lib/contact.ts`, whose entry point takes
the property, and which returns nothing to call when the household is marked Do
Not Contact. `npm run verify:dnc` covers it. **The app no longer contacts a
household that asked not to be contacted.**

**What is still open, and is why this remains a question.** Suppression is
per-property, because that is where the flag lives — while phone numbers live on
`contacts` and a household can have several. Nothing suppresses a named person or
a specific number, and nothing carries the flag across a re-import of the same
address in a later list.

**For counsel.** Whether DNC must be enforced in-app and at what granularity
(property / person / number); whether it must survive re-import of the same
address; whether handing off to the device's own dialer rather than sending
anything ourselves changes the TCPA analysis, including the pre-written SMS body;
whether DNC registry scrubbing applies when first contact is a knock; and whether
a DNC record should be permanent and irreversible.

---

### 3. Photographs kept forever, deletable by nobody

**What exists.** `photos` carries `captured_lat`, `captured_lng`, `category`,
`width`, `height`, `bytes`, `created_at`. Image bytes are in Cloudflare R2. A
copy also stays in each phone's IndexedDB — deliberate, see task #17, so a rep
keeps their work offline.

**What the code does.** Reads require a session and are scoped by `client_id`.
Beyond that there is **no retention period and no deletion path**.

Every `DELETE FROM` in `api/src/` was enumerated. Deletions exist only for
`client_geocoders`, `client_integrations`, `integration_outbox`,
`schema_migrations`, `applied_mutations`, `route_stops`, `login_attempts` and
`users`. **Nothing deletes a photo, property, contact, note, visit or activity
record.** There is no data-subject deletion path in the product, and nothing
expires on a schedule.

Backups compound it: every dump holds all of it, and copies persist on reps'
phones outside any server-side deletion.

**For counsel.** How long photographs of private property may be kept; whether
consent is required to photograph from the street or the doorstep; whether a
deletion request must reach reps' phones and encrypted backups or only the server
copy; who may view a photo; and what to do about photographs already taken in
testing.

---

### 4. Google's licence terms against an offline map

**The conflict.** Google Maps Platform terms permit only temporary caching of
returned coordinates, on the order of thirty days. This app writes them to D1 and
to every phone and keeps them for the life of the record, because the map must
draw with no signal. Offline is the product's founding requirement.

**What the code does.** Live only once `GOOGLE_MAPS_API_KEY` is set. Google leads
the address-lookup chain with the US Census Bureau geocoder beneath it; Census
output is federal public-domain data with no comparable restriction. The
constraint is recorded next to the code it governs in `api/src/geocode-google.ts`
and `api/wrangler.toml`. A per-company provider picker exists, so a customer can
bring a geocoder whose terms permit storage.

**For counsel.** Whether storing Google-derived coordinates past the caching
window is an acceptable commercial risk; if not, whether to move to a
storage-permitted geocoder or to store Place IDs and resolve online — which
removes the offline map; whether the answer changes if Census produced the
coordinates and Google only draws the map; and whether a customer connecting
their own Google key shifts the obligation to them.

---

### 5. The app also tracks the people using it

**What is recorded.** `visits.start_lat`, `start_lng`, `start_accuracy` — where
the rep physically was when each visit began. `photos.captured_lat/lng` geotags
every image. `daily_stats` holds per-rep daily knocks, conversations,
appointments, quotes, sales and pipeline value. `activity` logs individual
actions. A leaderboard ranks reps against each other.

Reps are the customer's employees or contractors. They are not our users
contractually, and they do not choose whether to use the app.

**What the code does.** Location is requested once per session, not tracked
continuously (task #28) — a position stamp per visit and per photo, no movement
trail. Nothing tells the rep their location is recorded, and there is no way to
decline.

**What is mitigating, offered so the question is not answered on a worse version
of the facts than the real one.** There is no beacon and no breadcrumb trail. A
position is stored when a rep logs a visit and at no other time, so the record is
silent about anyone outside working activity and goes stale the moment they stop
logging. A manager sees the last door a rep logged and when; the rep sees the
same screen about themselves. And nothing here is collected *in order to* monitor
anybody — every field exists for the sales work, and is monitoring only as a side
effect.

For a while this reasoning had the question filed under "no action needed" in
`LAUNCH.md`. It was reopened when the schema was enumerated to write this
document, because "there is no continuous tracking" and "we store an employee's
GPS position at each visit and never mention it" are both true, and only the
first had been written down.

**For counsel.** Whether employee-monitoring notice or consent obligations attach
and in which states; whether that is ours or the employing company's, and so
whether it is a contract term rather than a code change; whether something must
be shown to the rep in-app with a way to decline; and whether the performance
ranking raises anything separate.

---

## Where the data goes

Every external service that actually receives data. Several other providers
appear in `api/src/geocode-providers.ts` as sign-up links in a settings menu;
those receive nothing.

| Service | Receives | Purpose | Status |
| --- | --- | --- | --- |
| Cloudflare | everything | Workers, D1, R2, Pages | live |
| Google Maps Platform | addresses, coordinates | geocoding, routes, map display, Street View | live |
| US Census Bureau | addresses | free geocoding, public-domain output | live |
| MapTiler | tile coordinates | offline map imagery only — no addresses | live |
| GoHighLevel | contacts, visit outcomes | optional CRM sync | built, not connected |

Navigation hand-offs open Apple Maps or Google Maps on the rep's own device with
a destination address in the link — the device's browser, not our servers.

## What is already in place

Offered so the gaps above are read against what exists.

| Control | State |
| --- | --- |
| Tenant isolation | in place — every route swept, `verify:api-access` |
| Password storage | in place — hashed with a server-side pepper |
| Customer CRM credentials | in place — encrypted at rest, key outside D1 |
| Database backups | in place — AES-256-GCM, refuses to write plaintext |
| Retention policy, any data type | **none** |
| Deletion path for a homeowner record | **none** |
| Consent or list-provenance record | **none** |
| Do Not Contact enforcement | **recorded, not enforced** |
| Privacy notice shown to a homeowner | **none** |

## What is waiting on the answers

Buildable as soon as each is answered:

- **Q2** — status checks on the contact controls plus a granularity decision. A
  day at most, and the defect half should probably be fixed regardless.
- **Q3** — a deletion path across D1, R2 and the copies on reps' phones, plus
  scheduled expiry. The largest item here, and it does not exist in any form.
- **Q1** — consent and provenance fields, and an import step that captures them.
- **Q5** — possibly nothing in code, if the obligation sits with the employer.

**Q4 is different.** Not a gap to fill but a choice between three outcomes, one
of which removes the offline capability the product is built around. It is the
only one of the five where the answer could change what the product is.
