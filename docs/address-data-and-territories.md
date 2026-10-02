# Address data and territories

How All-Star knows which houses exist, how a territory drawn on the map
becomes leads, and how an imported spreadsheet becomes leads. Written for
whoever has to answer "why did this territory get 40 leads when I can see 60
houses?" or "what does an import cost?". The loading scripts are described in
more detail in `docs/ADDRESS_SOURCES.md` and `docs/ADDRESSES.md`.

## 1. Where the addresses come from

| Source | Role | What it is | Coverage | Licence / restrictions | Cost |
|---|---|---|---|---|---|
| **Overture Maps — addresses theme** | Primary | ~126 M US address points, itself built from the USDOT National Address Database (NAD), OpenAddresses and state/county files | Most states; gaps where jurisdictions publish to neither NAD nor OpenAddresses (see §7) | Open (CDLA-Permissive / ODbL-family, per source) — attribution in `ADDRESS_SOURCES.md` | Free, no key |
| **County / state files** | Fills Overture's gaps | Public address-point or parcel layers: Clark County WA, City of Milwaukee, Wisconsin V12 statewide parcels (Eau Claire, Dane, Kenosha), and 19 ArcGIS county layers (PA, GA, HI, SC, MO, LA, OK) — listed in `api/scripts/county/sources.json` with publisher and licence note | Only the counties listed | Per publisher; recorded per source. Bucks County PA was **not** loaded (its terms forbid commercial use) | Free |
| **Overture Maps — buildings theme** | Rooftops | Building footprints reduced to one point each, with a home / non-home / unknown flag | National | Open (ODbL) | Free |
| **US Census TIGER/Line address ranges** | Free fallback | "Numbers 100–198 are on this side of this block" for every street | National (all 3,227 county files) | Public domain | Free |
| **Geocodio** (reverse geocoding) | Optional paid fallback | Names a home rooftop that has no address point and no street range near it | US | Commercial API; results may be stored | $1.00 per 1,000 after 2,500 free a day; capped at 2,000 look-ups per territory press (≤ $2). Off unless `GEOCODIO_API_KEY` is set |
| **Google Geocoding / US Census geocoder** | Import only (§5) | Turns a spreadsheet address with no latitude/longitude into a point | US (Census); worldwide (Google) | Google: terms restrict storage outside Google Maps display — see §5; Census: public domain | Census free; Google $5.00 per 1,000 after 10,000 free a month, on the company's own key |

**Primary vs fallback, for a territory:** a published address point (Overture
or a county file) always wins. A home rooftop with no point near it is named
from the Census street range (stored as `INTERPOLATED` — "confirm the number at
the door"). Only a rooftop with neither goes to Geocodio, and only when a key
is configured.

## 2. How the data is prepared and stored

Everything is preprocessed offline and stored in one R2 bucket,
`allstar-addresses`, bound to the Worker as `ADDRESSES`. Nothing is queried
from a third party when a territory is drawn, except the optional Geocodio
step.

| Key | Contents | Built by |
|---|---|---|
| `v1/14/{x}/{y}.json` | Address rows `[number, street, unit, city, state, zip, lng, lat]` for one z14 Web-Mercator tile (~2 km) | `npm run national:build -- --theme addresses` (Overture) and `npm run addresses:build` / `node scripts/county/load-all.mjs` (county files merged into the same tiles) |
| `b1/14/{x}/{y}.json` | Rooftops `[lng, lat, kind]`, kind `r` home / `n` non-home / `u` unknown | `national:build --theme buildings` |
| `r1/14/{x}/{y}.json` | Census street ranges (street, side, from–to numbers, ZIP, geometry) | `national:build --theme tiger` |
| `zip-cities.json` | ZIP → town, for estimated addresses that arrive without one | `npm run zip-cities:build` |

**Normalisation and de-duplication while building** (`api/scripts/lib/address-tiles.mjs`):
- Streets are written the way Overture writes them ("North Main Street"). County spellings ("N MAIN ST") are expanded by the county loaders.
- Two rows are the same door when house number, `canonStreet()` spelling (directions and types reduced: `northeast 78th street` = `ne 78th st`) and unit match, and either the ZIP matches or the two points are within 150 m. The row already in the tile (Overture's) is kept.
- Rows with no number, no street or no usable point are dropped.

**Indexing** is the tile grid itself: a territory reads only the tiles its
bounding box touches. There is no database index over addresses; D1 never
holds the national data.

**Leads**, once created, live in D1 (`properties`, `contacts`, …). Only leads
are in the database, never the national address set.

## 3. Polygon → leads, step by step

`POST /api/territories` (`api/src/territories.ts`) then
`generateLeadsForTerritory` (`api/src/addresses.ts`). "Find addresses" on an
existing territory runs the second half again.

1. **Validate the shape.** At least 3 and at most 200 vertices, and a name not already used (case-insensitive). The office roles only. (Looking up houses also requires the shape to touch the US.)
2. **Claim existing leads (one transaction).** Every lead the company already has is tested against the polygon in the Worker (the same point-in-polygon test the browser uses). Inside, or within 5 m of the line when no other territory has it, is claimed. The territory row, its reps and the claim are written in **one D1 batch**, so a failure leaves nothing behind.
3. **Candidate lookup.** The tiles covering the polygon's bounding box (plus a 5 m margin) are read from R2, at most 96 tiles (larger shapes are refused with "draw it as two or three smaller ones").
4. **Bounding box → polygon containment.** Each address row is kept if it is inside the line, or outside by no more than `EDGE_TOUCH_METRES` (5 m — the line runs through the house).
5. **Validation.** Rows with no coordinates, number or street are counted as `invalid`.
6. **De-duplication in the data.** The same address twice (two sources) is counted once (`duplicateInData`).
7. **Residential filter.** An address point on a rooftop Overture classes as non-home (shop, school, church…) is not a lead (`nonResidential`).
8. **Gaps.** Home rooftops that no address point claims (within 50 m; a point holding many units claims up to 40 buildings within 80 m) and no existing lead is near are named from Census ranges, then (optionally) Geocodio.
9. **Existing-lead check.** Against every lead in the company: the same normalised address key, or the same house number on the same street within 12 m, is "already a lead" (`existed`). Addresses erased under a privacy request stay erased (`erased`).
10. **New lead creation.** Deterministic ids (from the address), `INSERT OR IGNORE`, in batches of 100 statements. At most 5,000 new leads per press; the rest are reported as `skipped`. A single assigned rep gets the new leads; a shared territory leaves them unassigned for the field.
11. **Report.** The response and an audit-log entry carry every count above (`diagnostics`), and the Worker log has one `territory.generated` line per press.

Coverage is reported per territory as `GOOD` (≥ 90% of home rooftops have a
published address point), `PARTIAL` (≥ 50%), `LIMITED` or `NONE`.

## 4. Limits that matter

| Limit | Value | Where |
|---|---|---|
| D1 bound parameters per statement | **100** | Cloudflare. Every multi-id query goes through `bindChunks()` (`api/src/d1.ts`). |
| Polygon vertices | 200 | `territories.ts` `MAX_POINTS` |
| Tiles per territory | 96 (~ a few square miles) | `addresses.ts` `MAX_TILES` |
| New leads per press | 5,000 | `addresses.ts` `MAX_NEW_LEADS` |
| Geocodio look-ups per press | 2,000 | `addresses.ts` `MAX_LOOKUPS` |
| Rows per import request | 500 (the console sends 250) | `import.ts` `MAX_IMPORT_ROWS`, `AdminImport.tsx` |
| Leads per bulk request | 500 (the console batches larger selections) | `assign.ts`, `lead-edit.ts` |
| Ids per export | 20,000 | `export.ts` `MAX_EXPORT_IDS` |

### The "about a hundred" failures (fixed 2026-10-02)

D1 refuses a statement with more than 100 bound parameters; local SQLite
allows 32,766, which is why every test passed and production failed. Fifteen
server functions split their id lists into chunks of 100 or 200 and bound
1–4 shared parameters on top, so each one failed somewhere between 96 and 100
rows. Measured against a local Worker before the fix:

| Size | Import | Bulk assign / status | List create | Territory create |
|---|---|---|---|---|
| 50 | ✅ | ✅ | ✅ | ✅ |
| 99 | ✅ | ❌ 500 | ❌ 500 | ❌ 500 (and left an empty "ghost" territory) |
| 100, 101, 181 | ❌ 500 | — | — | — |
| 1,000 (2 × 500) | ❌ both requests | — | — | — |

After the fix every operation succeeds at 50, 75, 90, 99, 100, 101, 125, 150,
181, 200 and 500 records, and a 1,000-row import completes. The test is
`npm run smoke:scale` (run by `npm run smoke:all`). Timings on the local
Worker: 500-row import 133 ms; 500-lead bulk status 1.3 s; 500-lead territory
claim 55 ms; 1,000-row import 0.5 s.

Territory **generation** at scale (§3 steps 3–10) reads R2 and was not part of
the local run, because the local Worker has no address bucket. The function it
failed in (`erasedAmong`, 201 parameters for 200 candidates) is the same one
the import test now exercises; generation itself was measured on production
data with the dry-run tool in earlier work (e.g. 289 leads in a Kenosha block).

## 5. Importing a spreadsheet

`src/admin/AdminImport.tsx` → `POST /api/import/geocode` (only for rows without
coordinates) → `POST /api/import/properties`.

1. The file is parsed in the browser (`packages/core/src/csv.ts`) and columns are matched by name.
2. **Rows without latitude/longitude are geocoded** in batches of 40:
   - with the company's own Google key (Settings → Geocoding), one request per address, 6 at a time — **external, billed to the company** at $5.00 per 1,000 after the free 10,000 a month;
   - otherwise, or for what Google cannot place, the **US Census batch geocoder** — external, free, no key, US addresses only, retried once without the ZIP.
   - A company that picks another provider in Settings runs Census only (the registry lists Geocodio, LocationIQ, HERE, Mapbox, Smarty, TomTom for display and spend estimates).
   - Usage is counted per day (`geocode_usage`) and the screen shows a cost estimate before a billable run. There is **no cache**: the same address in a later file is looked up again.
   - Rows that cannot be placed are listed and skipped, not imported at a guessed point.
   - **Storage note:** Google's terms restrict keeping geocoding results outside a Google map; the app stores the point on the lead. Census results have no such restriction. Keep the latitude/longitude columns in import templates until this is settled — the map and routes need coordinates.
3. **Import** in requests of 250 rows. Per request the server validates each row, rejects duplicates within the file and erased addresses, upserts by a deterministic id (a re-import updates a lead and never resets its status), and writes everything in one D1 batch.
4. **A failed request no longer stops the import.** Its rows are reported as failed, with a reference (`ERR-…`), and the rest of the file continues. The summary shows total rows, imported, updated, duplicates, could not be placed, and failed.
5. **"Territory Name"** puts every imported lead in a territory of that name. If one exists (by name, case-insensitive) the leads join it. If not, a territory **without an outline** is created — a named group to find and reassign the import as a unit — in the same batch as the rows, so an import that writes nothing creates nothing. A territory created this way can be given an outline later by drawing it. When the field is left empty, each lead with coordinates is placed in the drawn territory it falls inside, if any.

## 6. Territories as the source of truth

- Every Territory filter (Leads, Lists) reads the `territories` table.
- The Territories page lists every territory in that table, including ones with no leads (shown with 0 leads, so they can be renamed or deleted). It used to list territories by their leads, which hid empty ones while the filters still offered them — the "ghost" territories.
- **Create** is one transaction (§3 step 2). **Rename** changes only the name; leads hold the id, so the new name shows everywhere. **Delete** clears `territory_id` on its leads (the leads and their rep stay), removes its reps and the territory; it then disappears from every filter on the next refresh.
- Historical records keep what they were: a visit or an audit entry does not store a territory name.

## 7. Known coverage gaps

A per-county audit (share of home rooftops with a published address point,
on six sample tiles per county weighted by Census street ranges) put the US at
about 74% on 2026-10-01. Whole states are thin because their counties publish
to neither the NAD nor OpenAddresses: PR, HI (now filled for Honolulu), NH, NV,
SC, GA, SD, LA, MI, PA, ID and MO under 40%; WY, OK, MS and KS 60–70%. In
those places territories still get leads, but more of them are Census
estimates (`INTERPOLATED`) that the rep confirms at the door. County layers for
Las Vegas, Detroit, Cobb GA, Pittsburgh and others are on hosts the build
environment could not reach (see `ADDRESS_SOURCES.md`).

## 8. Costs, at a glance

- Territories: free, unless a Geocodio key is set (≤ $2 per press, usually far less).
- Imports with coordinates: free.
- Imports without coordinates: free through Census; billed per address on the company's Google key when one is connected.
- Storage: R2 for the national tiles (tens of GB), D1 for leads only.
