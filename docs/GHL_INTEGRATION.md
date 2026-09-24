# GoHighLevel integration — what exists, what is missing, what to build

> **Status: parked. Phase 2 at the earliest, and possibly never.**
>
> Nothing here is scheduled and nothing has been built from it. It is kept so
> that if the GHL integration is ever picked up, the research does not have to
> happen twice — the codebase survey, the two credential diagnoses and the
> ordering are all still good, and the first two were established by asking the
> live services rather than by reading code.
>
> Written 2026-09-24 against `main` at `521a4d6`. If that has moved a long way,
> re-check §3 before trusting the "already built" column.
>
> **One item should not be parked with the rest.** §2b found that the Cloudflare
> API token in this environment authenticates as a former collaborator and has
> no Workers, D1, R2 or Pages permission at all — so it cannot deploy this app.
> That is true today and has nothing to do with GoHighLevel. It is written up
> here only because this is the session that found it.

Written after reading the CRM code that is already on `main`. The short version:
**most of the infrastructure is built.** The outbox, the encrypted credential
store, the id-link table, the cron drain, the retry classification, the console
screen and a mock-GHL test harness all exist and are gated. What is missing is
the *content* of the sync — custom fields, opportunities, DND, notes, the lead's
own tags — plus one structural correction and one credential problem that blocks
everything.

Read this alongside README.md's "Integrations" section, which records why the
existing pieces are shaped the way they are. Nothing here overturns those
decisions.

---

## 1. The flow, confirmed

The direction asked for — app updates the dashboard, dashboard syncs to GHL — is
exactly what is already wired:

```
phone (offline queue)
  → POST /api/mutations            api/src/mutations.ts
  → applyOne() writes D1
  → queueForCrm()                  api/src/integrations.ts
  → integration_outbox row
  → cron "*/5 * * * *"             api/wrangler.toml
  → drainOutbox()                  api/src/crm-push.ts
  → ghlFetch()                     api/src/ghl.ts
  → GoHighLevel
```

Two properties of this are worth keeping in mind, because they constrain
everything below:

- **Nothing is sent inline.** A rep's sync writes an outbox row and returns. A
  CRM queue failure is swallowed and logged rather than thrown, because
  `applyMutations` treats a throw as the mutation being *rejected* — a CRM
  problem would otherwise tell a rep on a doorstep that their visit did not save.
- **The drain is bounded** (25 rows, cap 100) and picks up where it left off, so
  a backlog clears over several ticks rather than one run that times out.

### Does this need a separate worker?

**No.** The existing `allstar-api` Worker handles it. The cron trigger, the
outbox and the drain are already there and already bounded; every item below is
an additional event type in the same queue and an additional branch in the same
`plan()` function. A second Worker would need its own copy of the credential
store, the link table and the D1 binding, and would buy nothing.

### Two-way sync

Already decided and already built, and the decision matches what was asked for.
`api/src/crm-inbound.ts` accepts a webhook on a per-company secret URL, and the
merge rule is **Allstar wins, absolutely** — nothing inbound is applied to a lead
that is already linked. Inbound therefore collapses to "leads GHL has that
Allstar does not". For a door-knock lead flow that is the right shape and needs
no change. Do Not Contact is sticky and one-way.

---

## 2. Blockers — neither is a code problem

### 2a. The GoHighLevel token has no scopes

`GHL_PIT` in this environment is a **real, valid token** — GHL recognises it. But
every endpoint refuses it:

| Endpoint | Result |
|---|---|
| `GET /locations/{id}` | 401 `The token is not authorized for this scope.` |
| `GET /locations/{id}/customFields` | 401 same |
| `GET /contacts/?locationId=` | 401 same |
| `GET /opportunities/pipelines` | 401 same |
| `GET /calendars/` | 401 same |
| `GET /users/` | 401 same |

That message is distinct from what GHL returns for a bad token. A deliberately
malformed token gives `Invalid Private Integration token`; no header at all gives
`No Authorization header found`. So the token is genuine and simply has **no
scopes ticked** (or none of the ones this integration needs).

**Fix, in the client's sub-account** → Settings → Private Integrations → edit the
integration → tick the scopes below → save. The token string does not change.

```
contacts.readonly          contacts.write
locations.readonly         locations/customFields.readonly
locations/tags.readonly    opportunities.readonly
opportunities.write        calendars.readonly
calendars/events.write     users.readonly
```

`locations/customFields.write` is only needed if we ever provision fields
ourselves — not on the chosen path, where the fields are made by hand.

Until this is fixed nothing can be verified against real GHL, including the
request shapes the existing code already carries a caveat about.

### 2b. The Cloudflare API token belongs to someone else and cannot deploy

Confirmed by asking Cloudflare directly:

- The token authenticates as **`rohel@letlois.com`** — not the current owner.
- `GET /accounts` returns an **empty list**.
- `workers/scripts`, `d1/database`, `r2/buckets` and `pages/projects` on the
  LetLois account (`40d6a92830a7cb75278c823f7f1b19a0`) all return
  **`Authentication error`**.

So it is not merely the wrong person's token — it has no Workers, D1, R2 or Pages
permission at all and **cannot deploy this app**. It appears to be scoped to
unrelated products (Websearch / Browser Run / AI Gateway).

**Fix:** create a new account-scoped API token from an account that owns
`allstar-api`, `allstar-db` and the two R2 buckets, with:

```
Account → Workers Scripts        : Edit
Account → Workers R2 Storage     : Edit
Account → D1                     : Edit
Account → Cloudflare Pages       : Edit
Account → Account Settings       : Read
```

Worth confirming separately that the *account* holding the production Worker is
LetLois and not Rohel's personal account, since `wrangler.toml` pins a D1
`database_id` but no `account_id`. If the resources live in a personal account,
they need transferring before anything else matters.

### 2c. GHL's documentation hosts are blocked (not a blocker)

`highlevel.stoplight.io`, `marketplace.gohighlevel.com`,
`developers.gohighlevel.com` and `public-api.gohighlevel.com` are all refused by
the environment's egress policy (403 on CONNECT). This is why `ghl.ts` says of
itself that it "does not invent an endpoint it has not been able to check".

**The API host itself — `services.leadconnectorhq.com` — is reachable.** Once 2a
is fixed, every request shape can be verified empirically against the real API,
which is strictly better evidence than documentation. Unblocking the docs hosts
would be a convenience, not a requirement. An environment variable cannot fix it;
it is a network-policy change.

---

## 3. What is already built

| Piece | File | State |
|---|---|---|
| HTTP transport, `Version` header, retry classification | `api/src/ghl.ts` | Done, verified |
| Encrypted credential storage, verify-before-store | `api/src/integrations.ts` | Done |
| Id mapping both directions, unique both ways | `integration_links` | Done |
| Outbox, dedupe key, backoff, 5-attempt cap | `integration_outbox` | Done |
| Cron drain, bounded, per-row isolation | `api/src/crm-push.ts` | Done |
| `contact.upsert` | `crm-push.ts` | Partial — see §4 |
| `appointment.create` | `crm-push.ts` | Built, shape unverified |
| Inbound webhook + Allstar-wins merge | `crm-inbound.ts`, `crm-merge.ts` | Done |
| Console screen: connect, queue counts, calendar, disconnect | `src/admin/IntegrationsPanel.tsx` | Done |
| Mock-GHL harness over real HTTP | `api/scripts/smoke-crm-push.mjs` | Done |

The mock harness matters for everything below: it runs a local HTTP server, points
the Worker at it with `--var GHL_BASE_URL:...`, and asserts on the actual bytes
sent. New events get built and gated against it before a live token is involved.

---

## 4. The structural correction — one contact per *person*

This is the one thing that is not merely additive, and it should land before any
data flows.

Today `contact.upsert` sends **one GHL contact per property**, picking the primary
contact and dropping the rest:

```
linkAs: { kind: 'contact', localId: propertyId }
```

The agreed model is **one GHL contact per person**, linked by
`Allstar Contact ID`, with `Allstar Lead ID` as the shared key for the house. A
house with a homeowner and a spouse is two GHL contacts, one property.

So the link key changes from `properties.id` to `contacts.id`, and
`contact.upsert` fans out one send per row in `contacts` rather than one per
property. The dedupe key changes with it (`contact:<contactId>`).

**Migration note:** any `integration_links` rows already written with
`kind='contact'` are keyed by property id and would be misread after the change.
Either migrate them (property id → its primary contact's id) or clear them and
let the upserts re-link, which is safe because the upsert is idempotent on phone
or email. Which applies depends on whether the production integration has ever
run — worth checking `SELECT count(*) FROM integration_links` before deciding.

The existing collision handling still applies and matters more now: two people in
one household sharing a phone number come back as **one** GHL contact, and the
link stays with whoever claimed it first. That path is already written and tested.

---

## 5. Field mapping — discovery, not provisioning

Per the decision taken: **the fields are created by hand in GHL, and the worker
reads them back and maps them.** Nothing in this integration writes the field
definitions.

The design that makes that safe is a discovery step rather than a hand-typed map:

1. A new `GET /api/integrations/ghl/fields` calls
   `GET /locations/{id}/customFields`.
2. It matches GHL's returned fields against the expected set **by name**, exactly
   as spelled in the field list.
3. It stores the resulting `{ key → GHL field id }` map in the existing
   `client_integrations.config` column, merged rather than clobbered (the
   calendar setting already lives there and `setGhlCalendar` shows the pattern).
4. The console shows a checklist: which expected fields were found, which are
   **missing**, and which GHL fields we ignored.

That last point is what makes hand-built fields workable. A typo or a renamed
field becomes a visible red line on the Integrations screen instead of a field
that silently never syncs. Re-running discovery after fixing a name is one click.

Sends only include fields present in the map, so a partially-built GHL account
syncs what exists and ignores the rest rather than failing the whole contact.

### The expected set

Sync keys — **create these two first**, everything depends on them:

| Field | Type |
|---|---|
| Allstar Lead ID | Single line |
| Allstar Contact ID | Single line |
| Primary Contact | Checkbox |
| Relationship to Property | Dropdown: Owner, Spouse, Tenant, Family, Other |

Property:

| Field | Type |
|---|---|
| Owner Occupied | Dropdown: Yes / No / Unknown |
| Roof Age (years) | Number |
| Square Feet | Number |
| Latitude | Number |
| Longitude | Number |
| Location Accuracy | Dropdown: Rooftop, Interpolated, Approximate |
| Territory | Single line |

Door-knock activity:

| Field | Type |
|---|---|
| Last Outcome | Dropdown: No Answer, Interested, Follow Up, Appointment, Quote Requested, Not Interested, Sold, Do Not Contact |
| Last Visit Date | Date |
| Visit Count | Number |
| Next Action Date | Date |
| Next Action Type | Dropdown: Follow Up, Appointment, Quote, None |
| Next Action Note | Single line |
| Allstar Rep | Single line |
| Lead Score | Number |
| Lead Source | Dropdown: Door Knock, Import, Referral, Other |
| Allstar List | Single line |

Doorstep details (these are the app's note tags, which are a closed set —
`spouse_needed`, `storm_damage`, `competitor`, `gate_code`, `dog`, `callback` —
so they map cleanly to fields):

| Field | Type |
|---|---|
| Decision Maker Needed (spouse) | Checkbox |
| Storm Damage Reported | Checkbox |
| Competitor Mentioned | Single line |
| Gate Code | Single line |
| Dog on Property | Checkbox |
| Callback Requested | Checkbox |
| Latest Field Note | Multi-line |

Links back:

| Field | Type |
|---|---|
| Allstar Lead URL | Single line |
| Photo Count | Number |

Photos stay in the app; only the URL crosses. Copying door photos into GHL would
spend a lot of storage and API calls for images nobody opens there.

**Dropdown values must match the spellings above**, because discovery matches the
*field* by name and the worker sends the *value* as a literal string. A dropdown
option spelled differently in GHL is rejected on send.

---

## 6. What to build, in order

Each step is independently shippable and gated against the mock before it ever
sees a live token.

### Step 1 — Field discovery and mapping
`GET /api/integrations/ghl/fields`, name matching, `config.fieldMap`, and the
found/missing checklist on the Integrations screen. Nothing syncs differently
yet; this is the foundation for everything after it.

### Step 2 — One contact per person
The §4 change: fan `contact.upsert` out per `contacts` row, re-key
`integration_links`, migrate or clear existing links. Ships before real data
flows, so the link table is right from the start.

### Step 3 — Custom field values on upsert
Extend `contactBody` with a `customFields` array built from `config.fieldMap`.
Only mapped fields are sent. Dates as the app stores them, converted to the format
GHL accepts — **to be confirmed against the live API**, as this is one of the
shapes the existing code carries a caveat about.

### Step 4 — DND and the lead's own tags
`dnd: true` on the contact when status is `dnc` or the outcome is
`do_not_contact`. One-way and sticky, consistent with the existing merge rule —
nothing inbound ever clears it. At the same time, send the lead's own `tags[]`
alongside the existing `allstar-*` status tags rather than only the derived ones.

### Step 5 — Opportunities
A new `opportunity.upsert` event and `kind='opportunity'` links (the union member
already exists; no code uses it yet).

- Pipeline: **Door Knocking**, stages `New → Contacted → Follow Up → Working →
  Appointment → Quoted → Won / Lost`, mapping 1:1 onto `LeadStatus`.
- One opportunity **per property**, attached to the primary contact — the status
  and the value are properties of the house, not of a person.
- Value from `opportunity_value`.
- `dnc` gets no stage: it sets DND and closes the opportunity as lost.
- The pipeline and stage ids are discovered the same way as fields
  (`GET /opportunities/pipelines`, matched by name) and stored in the same
  `config`. Inventing stage ids for someone else's board is exactly the failure
  the existing code avoided by using tags.

### Step 6 — Notes
A `note.create` event posting to `POST /contacts/{id}/notes`, carrying the note
body and its author. Needs its own link kind so a retried send does not post the
same note twice — the current link kinds do not cover it.

Alongside it, `Latest Field Note` (§5) gives the office the most recent note
without opening the note list.

### Step 7 — Appointments, verified
Already built. The work here is confirming the request shape against the live API
and the calendar the client creates, then setting the calendar id on the
Integrations screen. With no calendar set the app deliberately does not queue
appointments at all, so this stays off until someone turns it on.

### Step 8 — Rep assignment
Ships as the **Allstar Rep** text field (§5), which needs no GHL seats and no
mapping. If reps later get GHL logins, `GET /users/` plus a rep → GHL-user map in
`config` sets the real Assigned User, and the text field stays as the fallback for
unmatched reps. Building it this way means that decision costs a follow-up rather
than a rewrite — which is why it does not need answering now.

---

## 7. Triggering workflows

There is no clean "run this workflow" API to call, and inventing one would be
guessing. The way this is done in practice — and the way that survives the
customer editing their automations — is to give their workflow something to
listen for:

- a **tag** (the `allstar-*` tags already sent, plus the lead's own), or
- an **opportunity stage change** (step 5), or
- an **inbound webhook** on their side.

All three are things the client configures in GHL, not things this app calls. So
the app's job is to make sure the signals are present and correctly spelled, and
the workflows get built in GHL against them. Worth walking through with whoever
owns the GHL account once step 5 lands, since the stage changes are the most
useful trigger and they do not exist yet.

---

## 8. Live testing

The decision taken is to verify against the **live client sub-account**. That is
workable but it writes real records, so:

- Every verification record is named so it is obviously ours and obviously
  disposable, and the set is small — a handful, not a run of the lead list.
- Reads first. With scopes fixed, `customFields`, `pipelines`, `calendars` and
  `users` can all be confirmed read-only before anything is written.
- Writes happen one event type at a time, newest step first, checked in the GHL
  UI before moving on.
- Everything is gated against the mock before the live token is used at all, so
  the live run is confirmation rather than discovery.
- **The test records are deleted afterwards**, and the `integration_links` rows
  for them with it.

A scratch sub-account would remove this cleanup burden entirely if one becomes
available later; nothing in the plan depends on which is used.

---

## 9. What is needed from the account owner

1. **Fix the GHL token scopes** (§2a). Blocks all verification.
2. **Create a new Cloudflare API token** with Workers/D1/R2/Pages edit (§2b), and
   confirm which account actually owns the production resources. Blocks deploying.
3. **Build the custom fields in GHL** (§5), with the names and dropdown values
   exactly as spelled. Step 1's checklist will show anything missed.
4. **Create the Door Knocking pipeline** with the seven stages (§6, step 5).
5. **Create the calendar** appointments should book into (§6, step 7) — only if
   appointment sync is wanted.
6. **Decide whether reps get GHL logins** (§6, step 8) — not urgent; the fallback
   ships either way.
7. Optional: **unblock GHL's documentation hosts** (§2c). Convenience only.

Steps 3–5 are the client's GHL configuration and can happen in parallel with
steps 1–2 of the build.
