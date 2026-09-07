# Quick start — the whole loop, manager to rep

Written to be *followed*, in order, on one afternoon. Every step names the exact
screen, and where the app does not yet do something, it says so rather than
describing an intention.

Two audiences on two devices, and that split is the product:

| | Where | What they do |
| --- | --- | --- |
| **Manager / Admin** | Console, on a laptop (`/admin`) | Import addresses, draw territories, hand them out, read the numbers |
| **Field Rep** | The app, on a phone | Today, Map, knock, log |

The console is desktop-only on purpose. Everything a rep does is phone-first.

---

## 0. Before anything — what the map needs

**Read this first if the pins look like they are floating over the wrong
houses. They are, and this is why.**

The app ships with **two map renderers**, and they are not equivalent:

| Renderer | When it is used | What you see under the pins |
| --- | --- | --- |
| `GoogleFieldMap` | Only when **both** `VITE_GOOGLE_MAPS_KEY` **and** `VITE_GOOGLE_MAP_ID` are set at build time | Real Google basemap — actual streets, actual rooftops |
| `FieldMap` | Everywhere else, always | A **synthetic street grid**: an invented lattice at roughly block spacing, plus MapTiler raster tiles over the top *if* `VITE_MAPTILER_KEY` is set |

`FieldMap`'s grid is not a map of your city. It is a plausible-looking texture so
the screen reads as a map when there is no signal (`src/components/map/FieldMap.tsx`,
`STREET_GRID_FROM_ZOOM`). The pins are at their true coordinates; the streets
underneath are drawn from nothing. **Nothing will ever line up on that renderer.**

So, before testing anything to do with pin placement:

```bash
cp .env.example .env.local
# set VITE_GOOGLE_MAPS_KEY and VITE_GOOGLE_MAP_ID — both, or neither counts
npm run dev
```

Both values are required together. A key with no Map ID is treated as
unconfigured (advanced markers do not render without one), and the app silently
keeps its own renderer — the single most common way to spend an afternoon on
this. To confirm which renderer you are looking at: open the browser console,
where a half-configured build logs `[allstar] Google Maps is half-configured: …`.

Two known consequences worth knowing before you file them as bugs:

- **The console's territory map is always `FieldMap`.** `AdminTerritories.tsx`
  imports the self-rendered map only, so a manager draws a boundary over the
  invented grid even on a fully configured Google build. The lead dots inside
  are real and the point-in-polygon maths is real; the streets are not.
- **Reps never see their territory outline.** The rep map filters by
  `assignedRepId` (`useScopedProperties`) and draws no boundary. "Your area" is
  the set of pins you can see, not a line on the map.

---

## 1. Manager: get addresses in

A territory drawn over an empty map assigns nothing, so **addresses come first.**

**Console → Import leads** (`/admin/import`).

1. Upload a CSV. `fixtures/test-leads-austin.csv` is 50 real Austin addresses
   with coordinates already in the file — start with that, since it does not
   depend on geocoding succeeding. For a bigger set:
   `npm run leads:sample -- 800`.
2. The wizard **auto-guesses the column mapping and then shows it.** The fixture
   deliberately uses export-style headers (`Property Address`, `Zip Code`,
   `Est. Value`) that match no internal field name, so this step is live.
3. The preview is real. Geocoding runs *before* the write, and rows that cannot
   be placed are **held back** rather than imported at 0,0.
4. Leave "territory" and "rep" blank on this first pass — you are about to draw
   the territory, and matching happens on import only.

Ids are a hash of `(tenant, normalised address)`, so **re-running the same import
is safe** and updates list facts (city, ZIP, valuation) without ever touching a
rep's work (status, visits, next action).

Scale: a few hundred to a few thousand rows is the normal case. There is no
enforced ceiling.

---

## 2. Manager: create and assign the area

**Console → Territories** (`/admin/territories`) → **New territory**.

**How you select the area — you draw it.** There is no "pick a ZIP" or "select
these 400 rows" path; the boundary is a polygon you tap out.

1. **Tap the map to drop a point.** Each tap adds one vertex.
2. At **three points** the shape closes, and the panel above the map starts
   counting **leads inside** and **square miles** live, updating on every tap.
   That counter is the feedback loop — watch it, not the shape.
3. **Undo point** / **Start over** are next to the counter.
4. Give it a **Name** (required — reps see it) and optionally pick **Assign to**.
5. Save. The confirmation is literal: *"Created Hyde Park with 412 leads."*

Every lead whose coordinates fall inside the polygon joins the territory. Nothing
outside is pulled in — a lead in no territory stays **Unassigned** rather than
being pushed to the nearest patch. Overlapping patches resolve to the **smallest**
one, so a downtown carve-out inside a city-wide patch behaves the way you meant.

**Assigning it (or re-assigning later)** is the **Assigned rep** dropdown on the
territory row. Changing it moves *every* lead in that patch to that person in one
action, and it works on the **Unassigned** bucket too — which is how you hand out
a first import you forgot to name a territory for. A patch whose leads disagree
reads **Mixed**.

Two things that will stop you cold if you do not know them:

- **Assignment requires a live account.** In demo mode the dropdown refuses with
  *"Assigning leads needs a live account. The demo has no real team."*
- Scoping is **server-side**. Unassign a rep and their next sync stops returning
  those properties — you cannot test this by only reloading the manager's tab.

The rep sees it **the next time their phone syncs**, which the console says out
loud after an assignment.

---

## 3. Rep: see the area

Sign in as the rep. Their whole world is now `assignedRepId === me`.

- **Leads** (`/leads`) — the flat list, nearest-first. This is the reliable
  "did the assignment land?" check.
- **Map** (`/map`) — the same set as pins.

**The filter chip will lie to you on day one.** The map defaults to **My route**,
and a rep with leads but no route planned yet sees *0 properties* while Leads
shows 400. The default falls back to **Open leads** when there is no route, but
if you have tapped a chip, tap **All** to see everything assigned.

To get a route: **Today → Plan N doors**. Nearest-neighbour from where the rep is
standing, built entirely on the phone (no server, works in a truck at 6am).
Already-knocked-today, closed, and coordinate-less leads are excluded.

---

## 4. Rep: pinning a house

This is the part where the app does **not** currently do what you described, so
here it is plainly.

### What exists today

**There is no tap-to-drop-a-pin on the map.** `MapScreen` and both renderers
wire map taps to *selecting an existing pin* only — `GoogleFieldMap` attaches
`gmp-click` to markers, and neither renderer has a map-surface click, long-press
or double-tap handler that creates a property. The only drawing surface that
takes taps is the console's territory tool.

The way a rep adds a house in the field is **Add lead**, reached from:

- **More → Add a lead**
- the **quick actions** button in the nav
- **Today**, when there is nothing to do

`/lead/new` sets the pin one of two ways, and the difference matters:

| | How the pin is set | Address quality |
| --- | --- | --- |
| **Pick from the address suggestions** (Google Places) | The **rooftop coordinates that come with the address** | Real city / state / ZIP |
| **Type the address, no pick** | **The rep's own GPS position** | City / state / ZIP saved **blank** — deliberately, rather than guessed wrong |

So the Google-Maps-address-lookup half of what you want is already there — it is
just on a form, not on the map. Picking from suggestions is also the better pin:
on a wide lot or a shared driveway, the rep's GPS is a different house than the
one they are standing in front of.

Then contact name and phone (both optional — the intent is to fill the rest in
during the visit), **Save lead**, and it opens straight into the property detail
where notes, contacts, conversation and status live. The write is
IndexedDB-first: saved instantly, queued, uploaded when there is signal.

### What you asked for, and what it would take

"Tap a house on the map and it becomes a pin with the address filled in from
Google" is a real gap, not a hidden feature. The pieces all exist —
`GoogleFieldMap` has the map instance, the app already loads the `places` library,
and `NewLead.save()` is the write path. The missing piece is a map-surface
handler that turns a tap's `latLng` into a reverse-geocoded address and hands it
to that save path. Say the word and I will build it.

---

## 5. Rep: work the door

Four taps, and this part is finished and solid:

```
Today → Start visit → Outcome → (note / photo) → Next action → Complete → Next property
```

`No Answer` short-circuits the middle and finishes in two.

Everything is written to IndexedDB first and queued; the sync chip — always
visible, top of the map — is the only thing that tells you whether it has reached
the server. Nothing in the UI ever waits on the network.

---

## The five-minute test script

```bash
cp .env.example .env.local     # set BOTH Google values, or step 4 tests nothing
npm run dev
```

1. Sign in as an office role. **Console → Import leads** →
   `fixtures/test-leads-austin.csv`. Confirm the mapping preview is populated and
   the write reports 50 imported, 0 held back.
2. **Console → Territories → New territory.** Tap four points around Hyde Park.
   Watch the "leads inside" counter move on every tap. Name it, assign it to a
   rep, save. Expect *"Created … with N leads."*
3. Sign in as that rep. **Leads** should show N. **Map** → tap **All** → the same
   N as pins. If Map says 0 and Leads says N, you are on the **My route** filter.
4. Zoom to 18 on one street. **This is the alignment test.** On a configured
   Google build the pins sit on rooftops; if the streets underneath look invented,
   you are on `FieldMap` and your env vars did not take — check the console for
   the half-configured warning.
5. **More → Add a lead.** Type `700 W 41st St`, **pick it from the suggestions**,
   save. It should land on the map at the rooftop, at zoom 18, in the right place.
   Then try the same address *typed without picking* — the pin lands on your GPS
   and the city/ZIP save blank. That contrast is the pinning model in one test.
6. **Today → Plan N doors** → **Start visit** → `No Answer`. Watch the sync chip.
   Turn off the network and do another; it still completes.

## Known gaps this guide found

1. **No tap-to-add-pin on the map.** Section 4.
2. **The console draws territories over a synthetic grid**, because
   `AdminTerritories` uses `FieldMap` unconditionally. On a Google-configured
   deployment this is now a downgrade rather than an offline fallback.
3. **Reps cannot see their territory boundary** anywhere in the app.
