# Sales data audit — lead fields, quotes, follow-ups, wins and pipeline value

What each sales-related field actually is, where it comes from and who writes
it, as of 2026-10-02. Written so product decisions (Josh / Curtis) start from
what the data really holds. "Changed" lists what this pass did; everything
else is unchanged behaviour.

## Lead Details fields

| Field | Column | Written by | Read by | Finding | Changed |
|---|---|---|---|---|---|
| Roof age | `properties.roof_age_years` | CSV import only ("roof age" / "roof year" columns — a *year* like 2008 was stored as an age) | Lead Details only | No logic depends on it; irrelevant to fiber/internet sales | Removed from Lead Details. Column and import mapping kept, so nothing already imported is lost |
| Square feet | `properties.square_feet` | CSV import only | Lead Details only | Same | Removed from Lead Details; column kept |
| Owner occupied | `properties.owner_occupied` | **Nothing.** Not an import field, no mutation, no enrichment | Lead Details | NULL on every live lead, and NULL was printed as **"No"** — a false statement on every house. Unrelated to the Homeowner / Renter tags (those are lead and note tags, `properties.tags` / `notes.tags`) | Shown only when a value actually exists; not inferred from tags. Decision needed: make it an editable field, or drop the column |
| Lead score | `properties.score` (`DEFAULT 50`) | Hard-coded **50** on every creation path (import, map/manual lead, CRM inbound, territory generation). Nothing recomputes it | Leads "Best score" sort; score bar on the lead, the map sheet and lead rows; CSV export column; read but not sent by the CRM push | Placeholder: every live lead has 50. Only the demo seed varies it | Score bar and "Best score" sort hidden. Column and export column kept. No formula invented |
| Territory | `properties.territory_id` | Territory draw, import, bulk move | Lead Details showed the **raw id** | — | Shows the territory's name |

A future score could use: Interested / Follow-up / Appointment / Quote / Sold
outcomes, negative outcomes (Not interested, Do not contact), recency of the
last visit, and meaningful tags. It needs product rules first.

## Appointments

- Table `appointments`: `id, client_id, property_id, rep_id, starts_at, duration_min (45), title, contact_id, notes`. **No status** (no confirmed / cancelled / no-show) and no update or cancel mutation.
- Created from a visit (outcome Appointment with a time → a 45-minute "Appointment") or from Schedule. The server records `rep_id` as whoever booked it, so a manager booking for a rep becomes the owner.
- Shown on Today, the lead, and the manager Overview.
- **Changed:** the office Leads table now has an **Appointment** column (next upcoming date and time, with the rep when different from the lead's), an **Appointment** filter (upcoming / has one / none) and a **Soonest appointment** sort, alongside the existing territory and rep filters. The lookup lives in `src/lib/appointments.ts` so a dedicated Appointments page can reuse it if approved.

## Send Quote

What "Send quote" does, end to end:
1. In the visit's Next step, "Send quote" with a time sets the visit's next action to `quote`.
2. Completing the visit creates a **task** of kind `quote` ("Send quote — <address>", due at that time) and sets the lead's next action label "Send quote".
3. The Quote outcome also moves the lead's status to `quoted`.
4. Ticking the task on Today writes an activity row `quote:<task id>` ("Quote sent") at that moment.

It **does not send anything**: no email, SMS, document, amount, line items,
API or GoHighLevel call. The CRM push has no quote event. `daily_stats.quotes`
counts visits with the Quote outcome, not quotes sent.

States the data can support today: **Not started** (no quote task, no
"Quote sent" line) → **Scheduled** (an open quote task, with its due time) →
**Sent** (task ticked; the time it was ticked). **Accepted / Declined / Failed
do not exist** — there is nothing that records them. **Changed:** the lead's
new "Sales activity" section shows the quote as Not started / Scheduled
<when> / Sent <when>. Adding Accepted / Declined needs a product decision and a
field.

## Follow-ups

- Table `tasks`: `id, client_id, rep_id, property_id, title, due_at, done, kind` (`follow_up`, `call`, `quote`, `admin`). No notes, completed_at, created_at or separate assignee (`rep_id` is whoever created it).
- Created from a visit's Follow up next step (and Schedule). Shown on Today and the lead's To do.
- "Overdue" was `due_at < now`, so something due at 5 pm was overdue at 5:01 pm and there was no "due today".
- **Changed:** overdue / due today / upcoming is now decided by the company's calendar day (`src/lib/followups.ts`), on Today, on the lead, and in a new **Follow-up** filter on the office Leads table (overdue, due today, has an open one, none).

## Sold / Won

- Selecting **Sold** in a visit: `visits.outcome = 'sold'` (with the rep who knocked and the time), `properties.status = 'won'`, an activity row, `daily_stats.sold` for that rep and day, and CRM tags `allstar-won` / `allstar-sold`. There is **no deal record, sale amount or won_at** field.
- A lead can also become `won` by a manual status change or the office's bulk status. Those do **not** touch `daily_stats`.
- So two numbers exist, and the screens use both:
  - **"Deals won" / Won column / leaderboard / Standings** = visits recorded as Sold in the period (`daily_stats.sold`).
  - **Pipeline "won", Territories won value, mobile Overview and Pipeline** = leads whose status is `won`, all time.
  - A lead set to Won by hand appears only in the second; a Sold visit later corrected away from Won stays in the first; two Sold visits on one lead count twice in the first.
- **Changed (labels only — Won is not redefined):** the dashboard tile now reads "… closed · sold at the door" and the pipeline card "N leads marked Won", so the two answers are not presented as one. The dashboard's "Today's outcomes" card counted every loaded visit, not today's; it now counts today's, on the company calendar.
- **Decision needed:** which definition is "Won" for reporting. Recommended: status `won`, with a `won_at` timestamp and the rep stamped when the status changes, and the visit-Sold count kept as "sold at the door".

## Pipeline and deal value

**Built (Option C):** a price list, and a sale of its own on every Won lead.

- **Plans** (`plans` table): name, price in whole dollars, active. Kept by
  managers and administrators in the console under **Plans**. A plan is retired,
  never deleted, so old sales still name it. Repricing a plan changes what the
  next sale on it is worth; sales already made keep the price they were made at.
- **Sales** (`deals` table, one row per lead, `deal_<property id>`): value,
  plan (id, name, and price at the time), rep, `won_at`, and — when a manager
  overrode it — who and why.
- **A plan on every lead** (`properties.plan_id`, migration 028). Anyone who
  may edit a lead can put it on a plan before it is sold — on the lead's Plan
  section, phone or console. An open lead is then worth its plan's price in the
  pipeline instead of its imported estimate; the console Leads table has a Plan
  column and filter. A lead sold without a plan picked at the door is sold on
  the plan it carries; "Not sure" at the door clears it.
- **Deleting a plan** (console → Plans → Delete, after a confirmation that
  says what it touches): leads on it go back to no plan; sales made on it keep
  its name and price. Retire remains the gentler option.
- **Opening a sale.** Any route to Won opens one: a Sold visit (the rep picks
  the plan at the door, or "Not sure — office sets it"), Won set by hand, or
  the office's bulk status change. Value = the plan's price; with no plan yet,
  the lead's imported `opportunity_value` (so nothing that read a figure before
  reads $0 now). A second Sold visit on a sold lead is not a second sale.
- **Changing a sale.** Anyone who may edit the lead can move it onto another
  plan (it takes that price). Only a manager or administrator can set a
  different value, and must give a reason; both are recorded on the sale and as
  a line in the lead's activity.
- **Closing a sale.** A lead leaving Won (another outcome, a hand-set status,
  the bulk change) cancels its sale, which takes its money off the day it was
  won. Sold again later, it reopens with a new `won_at`.
- **"Won" for reporting** is now: status `won`, which always has exactly one
  standing sale, with its `won_at` and rep. The visit-Sold count stays as
  "sold at the door" (`daily_stats.sold`).

Where the money shows:

| Screen | Value |
|---|---|
| Dashboard "… closed", rep table "Closed", Reports "Closed", Standings revenue | `daily_stats.pipeline_value` = SUM of standing sales won that day by that rep (`recomputeDailyStats`, `api/src/deals.ts`) |
| Pipeline "won", Territories won value, Leads "Value", lead / map / row value, Overview, Team | `leadValue()` (`packages/core/src/deals.ts`): the sale's value on a Won lead; on any other lead its plan's price, or the imported estimate when it has no plan |
| CSV export | `opportunity_value` (estimate) plus `sale_plan`, `sale_value`, `won_at` |

Open leads are still valued only by the imported estimate — the only figure an
open lead has. Leads that were already Won when this shipped were backfilled
(migration `027-plans-deals`) at their imported value, credited to the rep and
time of their latest Sold visit (or the assigned rep and last update).

`api/scripts/rebuild-daily-stats.mjs` and `rebuild-closed-value.mjs` now read
money from the sales too. Prefer `rebuild-daily-stats.mjs`: the other buckets
days in UTC.

Still not built: quote amounts, Accepted / Declined quotes, and pushing the
sale to GoHighLevel.

## Product / plan / opportunity — readiness

The schema has **no** product, plan, package, service, deal or opportunity
table. "Opportunity" exists only as the `opportunity_value` column and as an
unused `integration_links.kind` value.

| Option | What it is | Fits |
|---|---|---|
| A. Manual deal value | Rep or office types the value when Sold | Simplest; one editable field on the lead (or on a new deal row). Values vary by rep accuracy |
| B. Select plan → default value | A `plans` table (name, monthly price, term, active) per company; Sold asks for the plan; value derived | Consistent reporting; needs the real plan list |
| C. Plan → default value + authorised override | B, plus an override field allowed for managers (or reps) with the reason recorded | Most accurate; most to build |

**Chosen and built: C** (see above). The original recommendation: C, built as a `deals` table — `id, property_id, rep_id,
plan_id, value, value_overridden_by, status (open / won / lost / cancelled),
won_at, created_at` — written when Sold is recorded, with
`properties.opportunity_value` kept as the imported estimate. That gives Won a
timestamp, a rep and a value from one place, and lets mobile and admin count
it the same way. It needs the real plan list and the Won definition above
before it is built.
