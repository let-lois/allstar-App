# Address sources for territory leads — research and design

Status as of September 29, 2026. Companion to `docs/ADDRESSES.md` (setup) and
`LAUNCH.md` (legal items).

## The question

When a territory is drawn anywhere in the U.S., can All Star find the houses
inside it for free, and keep those addresses as leads indefinitely, without
Google or a paid geocoder being the source of the stored address?

**Yes, with one caveat.** Published address points (Overture, which carries
the National Address Database and OpenAddresses) cover most metros; where they
are missing, every house still appears as an Overture rooftop, and Census
TIGER street ranges give it an estimated street address. All three are open
or public domain and may be stored and used commercially. The caveat: an
address estimated from a street range has the right street, side and ZIP, but
its house number is an estimate, so those leads are stored as `INTERPOLATED`
and the rep confirms the number at the door.

## Measured coverage today (published address points)

Share of home rooftops (Overture buildings, residential or unclassified,
house-sized) that have a published address point within 25 m. One z14 tile
(~2 × 2 km) per place, read from the production bucket on 2026-09-29.

| Area | Homes | With address point | Coverage |
|---|---:|---:|---:|
| Denver CO | 1,415 | 1,400 | 99% |
| Chicago IL (suburban) | 8,351 | 8,261 | 99% |
| Columbus OH | 3,406 | 3,353 | 98% |
| Tulsa OK | 1,083 | 1,054 | 97% |
| Little Rock AR | 2,100 | 2,010 | 96% |
| Orlando FL | 1,730 | 1,653 | 96% |
| Phoenix AZ | 1,561 | 1,483 | 95% |
| Charlotte NC | 858 | 815 | 95% |
| Tampa FL | 3,343 | 3,184 | 95% |
| Boston MA | 1,519 | 1,448 | 95% |
| Austin TX | 1,107 | 1,033 | 93% |
| Omaha NE | 1,579 | 1,472 | 93% |
| Des Moines IA | 441 | 404 | 92% |
| Salt Lake City UT | 702 | 636 | 91% |
| Seattle WA | 765 | 690 | 90% |
| Boise ID | 2,072 | 1,855 | 90% |
| Round Rock TX | 1,607 | 1,424 | 89% |
| Kansas City MO | 606 | 514 | 85% |
| Birmingham AL | 565 | 476 | 84% |
| Atlanta GA (suburban) | 535 | 439 | 82% |
| Nashville TN | 351 | 281 | 80% |
| Jackson MS | 605 | 478 | 79% |
| Los Angeles CA | 323 | 242 | 75% |
| Rural Texas Hill Country | 1,865 | 1,194 | 64% |
| Powdersville SC | 468 | 0 | 0% |
| Greenville SC | 1,755 | 0 | 0% |
| Anderson SC | 1,482 | 0 | 0% |
| Detroit MI | 253 | 0 | 0% |
| Philadelphia PA | 3,666 | 0 | 0% |

Gaps are whole jurisdictions that do not publish to the National Address
Database or OpenAddresses, not scattered houses. A sample of Overture's U.S.
rows shows their origin: almost every state comes from the NAD; California,
Florida, Michigan and Mississippi from county files; Colorado, Massachusetts,
Minnesota and Oregon from statewide files. South Carolina's NAD contribution
covers few counties; Detroit (Wayne County) and Philadelphia are absent.

## Sources evaluated

| Source | Coverage | Address points | Free | Permanent storage | Commercial use | Residential info | Recommended |
|---|---|---|---|---|---|---|---|
| **Overture Maps addresses** | ~126 M U.S. points; most states; gaps above | Yes (published points) | Yes | Yes (CDLA-Permissive / ODbL-family per source) | Yes | No | **Yes — primary** (loaded) |
| National Address Database (USDOT) | Participating states/counties only; already inside Overture | Yes | Yes | Yes (public domain) | Yes | Some records carry a placement/type | Via Overture (a separate load adds almost nothing) |
| OpenAddresses | County/city sources worldwide; already inside Overture | Yes | Yes | Yes (per-source licences, mostly open) | Mostly | No | Via Overture |
| **Overture Maps buildings** | Nationwide rooftops (Microsoft, Google, OSM footprints) | No address; a real building point | Yes | Yes (ODbL / CDLA) | Yes | Building class where known | **Yes — finds every house** (loaded) |
| **Census TIGER/Line ADDRFEAT** | Every county | No — potential number **ranges** per street side | Yes | Yes (public domain) | Yes | No | **Yes — free gap-filler**, as INTERPOLATED only |
| County / municipal GIS address points | Varies; many open (e.g. Philadelphia, Detroit), many not (most SC counties) | Yes, authoritative | Usually | Usually (check each licence) | Usually | Sometimes (land-use codes) | Yes, per market where published (loader supports GeoJSON) |
| State address-point programs | ~25 states publish statewide | Yes | Yes | Usually | Usually | Rarely | Yes where not already in Overture |
| OpenStreetMap `addr:*` | Sparse in most U.S. suburbs | Yes where mapped | Yes | Yes (ODbL: share-alike on the database) | Yes | Building tags | Low value in the U.S.; not needed |
| Parcel / assessor data (county) | Varies; often paid or restricted | Parcel site address | Sometimes | Varies | Varies | **Yes (land-use codes)** | Post-launch, for the residential flag |
| Commercial parcel/address data (Regrid, ATTOM, Smarty) | Nationwide | Yes | No | Licensed | Licensed | Yes | Only if open data proves insufficient |
| Geocodio (reverse geocoding) | U.S./Canada | Returns an address for a point (often itself range-interpolated) | 2,500/day free, then $1.00/1,000 | Allowed by its terms | Yes | No | Optional last resort |
| Google Geocoding / Places | Worldwide | Yes | No | **No** — temporary cache only (≈30 days) | Display use | No | Not for stored leads |

Kinds of address, kept distinct in the data:

- **Address point** — a published location for a real address (Overture/NAD/OpenAddresses, county GIS).
- **Parcel address** — the site address of a land parcel (assessor data).
- **Building** — a real structure with no address (Overture buildings).
- **Census range** — the numbers a street side *could* hold (TIGER). Not a house.
- **Interpolated** — a number estimated from a range at a real building. Not confirmed.
- **Geocoder-generated** — a provider's answer for a point, which may itself be interpolated.

## Pipeline, as built

```
Territory polygon
      ↓
Published address points inside (Overture: NAD + OpenAddresses + county/state files)   → ADDRESS_POINT
      ↓
Overture rooftops inside: drop addresses on commercial/civic buildings,
find home rooftops with no address point or lead within 25 m
      ↓
Census TIGER range of the street each such roof faces (≤ 80 m)                            → INTERPOLATED
      ↓
Only roofs with no numbered street nearby, only if a key is set: Geocodio                 → GEOCODED
      ↓
A blank town filled from the ZIP (GeoNames postal codes, meta/zip-city.json)
      ↓
Normalise + deduplicate (import key; same number on the same street within 12 m;
never merge units; erased homeowners stay erased)
      ↓
Leads, with address_confidence, address_source and residential_status stored
```

County or state files where published are added to the address-point layer
with `addresses:build --geojson` (see `docs/ADDRESSES.md`).

### Deduplication priority

Where two sources name the same door, the higher one wins: county/state
address point → NAD / OpenAddresses (via Overture) → a rep's own entry →
Geocodio → Census interpolation. A published point always beats an estimate,
and a person's correction beats both for that lead (editing the street line
sets `MANUAL`).

### Confidence and residential status

Stored on every generated lead (migration `025-address-confidence`):

- `address_confidence`: `ADDRESS_POINT`, `GEOCODED`, `INTERPOLATED`, `MANUAL`; null for older leads.
- `address_source`: `overture`, `census_tiger`, `geocodio`, `manual`.
- `residential_status`: `RESIDENTIAL` where Overture calls the building a home;
  `UNKNOWN` where the building is unclassified; commercial/civic buildings are
  not made leads. Nothing is called residential without that evidence.

### Census TIGER interpolation — how reliable

- Street name, side of the street and ZIP come from the data and are reliable.
- The number is the nearest even (or odd, per the side) number to the roof's
  place along the block's range. TIGER ranges are *potential*: a block numbered
  100–198 may have houses 102–140, so an estimate can be several doors off.
- Pins stay on the real roof, so the rep is at the right house; the lead says
  "house number estimated — confirm at the door", and a correction is one edit.
- Roofs more than 80 m from any numbered street (long private drives, rural
  lots) are not estimated; they are counted and, if a Geocodio key is set, sent
  to it.

### Coverage diagnostics

Every look-up returns and the console shows: addresses found by source
(published points, Census estimates, Geocodio), residential/unknown counts,
commercial buildings left out, the share of homes with a published address
point, and a status — `GOOD` (≥ 90%), `PARTIAL` (≥ 50%), `LIMITED` (below),
`NONE` (no data) — with the reason when it is not good.

## Paid fallback

Can we avoid Geocodio entirely? **Yes, for generating and storing leads.**
With the TIGER load in place every home rooftop near a numbered street gets an
address from open data. Geocodio remains an optional extra for roofs no
numbered street is near, and it is off unless a key is set. What it cannot do
is make an estimate exact: its own reverse answers are often range
interpolation too. The share of homes that would still need it can only be
measured once TIGER is loaded; it is expected to be small.

## Costs (estimates)

| Item | Estimate |
|---|---|
| Address data (Overture, NAD, TIGER) | $0 — open / public domain |
| R2 storage: addresses (~10 GB), rooftops (~5 GB), TIGER ranges (a few GB) | ≈ $0.30 / month |
| One-time R2 writes (≈ 2.5 M tiles done; TIGER ≈ 1 M more) | ≈ $11 done + ≈ $5 |
| Reads per territory (≤ 3 × 96 small objects) | fractions of a cent |
| Processing (run the loaders on any machine) | $0 |
| Geocodio fallback (optional) | $0 under 2,500 look-ups a day; $1.00 per 1,000 beyond |
| **Expected monthly total** | **under $1 plus the existing Workers plan** |

## Towns for estimated addresses

Census ranges carry the street, the side, the ZIP and the state, not the town.
The Worker fills a blank town from a ZIP → postal-town table built from the
[GeoNames](https://www.geonames.org/) US postal-code list, **licensed CC BY
4.0** (attribution: "Postal code data © GeoNames, CC BY 4.0"). 41,488 ZIPs,
about 800 KB, at `meta/zip-city.json` in the address bucket:

    npm run zip-cities:build -- --upload --account <id>

The first place GeoNames lists for a ZIP is used (29611 → Greenville,
29673 → Piedmont). A ZIP the table does not know keeps a blank town.

## Local address files loaded

| Area | Source | Licence | Loaded | Result |
|---|---|---|---|---|
| City of Milwaukee, WI | Master Address Index (residential rows, `RES_COM_FLAG = R`) placed at parcel centroids from the city's parcel layer — `api/scripts/county/milwaukee.mjs` | CC BY (credit: © City of Milwaukee) | 2026-09-30, 265,660 addresses | Sample blocks went from 0% to 98–99% published address points; 12–26 non-residential buildings per block left out |

Wisconsin has no current statewide address file: the State Cartographer's
Office lists only the 2014 LinkWISCONSIN aggregation (2013 data, not
maintained). Counties that publish are already in Overture (Madison 89%,
Green Bay 93% measured), which is why Milwaukee was the Wisconsin gap.

Rebuild when the city updates its data:

    node scripts/county/milwaukee.mjs --out milwaukee.geojson
    npm run addresses:build -- --bbox -88.0650,42.9205,-87.8680,43.1925 \
      --geojson milwaukee.geojson --fields number=number,street=street,unit=unit,city=city,zip=zip \
      --state WI --upload --account <id>

## To finish

1. Census TIGER ranges: loaded nationally on 2026-09-30 (all 3,227 county
   files) with `npm run national:build -- --theme tiger --upload --account <id>`.
   The Census firewall refuses bursts; the loader backs off, retries a refused
   file under `?try=N`, and lists anything still refused in `read.skipped`.
2. Re-measure coverage in the gap areas and record the share still needing a
   fallback. Dry run on production data (2026-09-30): Powdersville SC 239 of
   313 home rooftops named, Detroit 665 of 666, Philadelphia 2,183 of 2,222.
3. Post-launch: county address points for Philadelphia/Detroit-type gaps,
   parcel land-use for a residential flag.
