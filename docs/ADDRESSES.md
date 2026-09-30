# The houses inside a territory

Drawing a territory on the console map finds every address inside it and makes
each one a lead. Josh drew round fifty houses and got two leads because, until
this, a drawn shape only claimed the leads that *already existed* — nothing
looked up what was on the ground. This does, from open data, with no key and no
per-call bill.

## Where the addresses come from

[Overture Maps](https://overturemaps.org) publishes an `addresses` theme: one
point per address, built from OpenAddresses and released monthly under open
licences (CDLA-Permissive-2.0 and the ODbL-family licences of the sources).
It is about 28 GB for the world. We do not download it. `addresses:build` reads
the release's Parquet files straight from Overture's public bucket, fetches only
the row groups whose bounding boxes overlap the area you ask for, and writes
that area as map tiles: one JSON file per z14 Web-Mercator cell (about 2 km
across in the continental US), each holding compact rows

    [number, street, unit | null, city, state, zip, lng, lat]

The Worker keeps those tiles in an R2 bucket bound as `ADDRESSES`. A territory
covers a handful of cells; the Worker reads them, runs the same point-in-polygon
test the map ran while you were drawing, and writes a lead for each address.

Coverage is whatever you build. A shape drawn outside it finds nothing rather
than something wrong. There is no residential/commercial flag in the data, so a
corner shop becomes a lead too — a rep marks it Not interested and moves on.

## Which houses are in a territory

Each house is one point: its published address point, or its roof's centre
when the address data has none. A house is in the territory when that point is

- **inside the drawn line**, or
- **outside it by no more than 5 m** (`EDGE_TOUCH_METRES` in `api/src/geo.ts`):
  the line runs through the house.

A territory is drawn by hand along streets and fences, so its line lands on
the houses themselves, and a house the line visibly crosses has its point a
few metres to one side. Before this rule only points strictly inside counted:
on a real three-point territory in Clackamas County, OR, that made 6 leads
where the line took in 15 houses — the other 9 points sat 1.3–4.8 m outside.
The next house out was 8.6 m away. Five metres is under half the width of the
smallest house, so the allowance takes in the houses the line crosses and not
their neighbours.

The same rule is used for rooftops (houses with no address point) and for the
leads already inside when a territory is drawn, with one difference: a lead on
the line that already belongs to another territory stays there, so drawing a
neighbour along a shared boundary never takes its houses.

Every press logs one line (`event: "territory.generated"`) and returns
`diagnostics`: rows read, invalid, outside, inside, on the edge, duplicates in
the data, non-residential, existing leads, erased, over the cap, insert
conflicts and created, so a territory with fewer leads than houses on the map
can be explained from the numbers.

## What does not become a lead

- An address that is already a lead in this company, by the same normalised key
  the CSV import uses, or one within about 12 m of an existing lead with the
  same house number on what reads as the same street — two spellings of one
  door ("12 Insde St" is "12 Inside St"). A unit (apartment, suite) is never
  folded into the building or another unit, and a different suffix is a
  different street: "12 Oak Ct" is not "12 Oak Dr".
- A homeowner who was erased. A redraw does not resurrect them.
- Anything past 5,000 new leads in one call. The call still succeeds and says
  how many it skipped; press **Find addresses** again, or draw the rest as a
  second territory.
- A territory that covers more than 96 cells (roughly a county). Draw two.

Pressing **Find addresses** twice is safe: every house it already made a lead
of counts as "already there", and the id is the import's deterministic one, so
even a race writes one row.

Each new lead carries `geo_provider = 'overture'` and `geo_precision =
'rooftop'`: an OpenAddresses point sits on the parcel, which for a house is the
roof or very near it. Status `new`, score 50, no contact — that is what the
door is for.

## Who gets the leads

The same rule as drawing a territory or adding a rep to one. If the territory
has **one** rep, the new houses are handed to them (`assigned_rep_id`). If it
has **two or more**, the houses stay unclaimed: everybody on the patch sees
them, and whoever knocks a door takes it. Either way every rep on the territory
sees every lead in it.

## Setting it up

Once per deployment, from `api/`:

1. Create the bucket:

       npx wrangler r2 bucket create allstar-addresses

2. Bind it. `wrangler.toml` binds `ADDRESSES` to `allstar-addresses` (done
   on 2026-09-28, once the bucket existed). `wrangler deploy` refuses a
   binding whose bucket does not exist, and this repo deploys on every merge,
   so the bucket always comes first. A bound, empty bucket is safe: a territory
   is created with no new leads until its area's tiles are uploaded.

3. Build and upload the ground you sell on, as a bounding box
   (`minLng,minLat,maxLng,maxLat`). Austin's metro, for example:

       npm run addresses:build -- --bbox -98.10,30.05,-97.45,30.65 --upload --account <account id>

   `<account id>` is the Cloudflare account `allstar-api` deploys to (the one
   holding `allstar-photos`); without it, a login that can see several
   accounts stops to ask. A failed upload stops with wrangler's message
   rather than leaving half an area uploaded.

   That reads about forty row groups, takes a few minutes, and uploads a few
   thousand tiles. Repeat for each market. The box is widened to the whole
   tiles it touches, so every tile written is complete: re-running over the
   same box rewrites the same tiles, and a neighbouring box rewrites the
   shared edge tiles identically and adds the rest.

   `--upload` needs `wrangler login` or `CLOUDFLARE_API_TOKEN` with R2 write
   access. Without `--upload` the tiles are written to `./addr-tiles` for a
   look first. `--release YYYY-MM-DD.N` pins an Overture release; the default
   is the newest.

4. Check: `/api/health` reports `config.addresses: true`, and drawing a
   territory in the console offers **Find the houses inside and add them as
   leads**, ticked by default.

Refreshing the data is step 3 again with a newer release. New houses on a
street that was already built appear on the next **Find addresses**.

## The whole United States

`npm run national:build` loads every U.S. address Overture has (about 126
million) and, with `--theme buildings`, every U.S. rooftop, into the same
bucket. It reads Overture's release once, writes the U.S. rows into one file
per ~70 km cell on disk, then tiles each cell whole and uploads through R2's
S3 API (the REST API wrangler uses allows about four writes a second, which
is a day for a country). Run from `api/` with `CLOUDFLARE_API_TOKEN` set to an
account token that can write R2; it derives the S3 key from it, prints nothing
secret, and resumes where it stopped if run again:

    npm run national:build -- --theme addresses --upload --account <id> --clean
    npm run national:build -- --theme buildings --upload --account <id> --clean

## Houses the address data does not name

Overture's addresses are county by county: Austin has every door, upstate
South Carolina almost none. Its buildings are everywhere. When a territory is
drawn the Worker reads both, and:

- an address on a building Overture calls commercial, civic, industrial, a
  school or a church is left out (counted as `nonResidential`);
- a home rooftop with no address point or lead within 25 m is a door the data
  missed. First, for free, it is named from the Census TIGER range of the
  street it faces (`national:build --theme tiger`): street, side and ZIP from
  the data, the house number estimated and stored as `INTERPOLATED` for the rep
  to confirm (see `docs/ADDRESS_SOURCES.md`). Only a roof no numbered street is
  near goes further: with `GEOCODIO_API_KEY` set on the Worker it is reverse-geocoded by
  Geocodio in batches of 500 — at most 2,000 per press, the rest waiting for
  the next press — and a U.S. street address on or next to that roof becomes
  a lead (`geo_provider = 'geocodio'`, pinned on the roof). Without the key
  those houses are counted and the console says the key is needed.

Geocodio, not Google, because a lead is a kept result and Geocodio's terms
allow keeping them (Google's are LAUNCH.md blocker 1). Pricing when this was
written: 2,500 look-ups a day free, then $1.00 per 1,000, so a press costs at
most $2 and usually nothing. A Geocodio failure or timeout never fails the
territory: the addresses the data had are written, and the rest are counted
with the reason so pressing **Find addresses** again retries them.

Set the key once:

    npx wrangler secret put GEOCODIO_API_KEY

`/api/health` reports `config.geocodio: true` (never the value).

## Where Overture has no addresses: a county's own file

Overture's US addresses come from OpenAddresses, and coverage is by county.
Austin is thick with them; upstate South Carolina has almost none (the whole
Greenville–Anderson box held 225). There, load the county's own address
points beside the Overture rows. Export them as GeoJSON in WGS84 (an ArcGIS
layer query with `f=geojson&outSR=4326` does it), then name the fields:

    npm run addresses:build -- --bbox -82.80,34.45,-82.10,35.10 \
      --geojson greenville.geojson --geojson anderson.geojson --geojson pickens.geojson \
      --fields number=ADDNUM,street=STREETNAME,unit=UNIT,city=CITY,zip=ZIP --state SC \
      --upload --account <account id>

Use `address=SITEADDR` instead of `number=`/`street=` when a county keeps the
whole "123 Main St" in one field. A parcel polygon is placed at its middle;
a row numbered 0 (a lot with no house yet) is skipped. The run tiles both
sources together, so each tile is whole and the same door from both is one row.

## What it costs

Overture's bucket is free to read. R2 storage for a metro's tiles is a few
hundred MB at most; reads are a handful of small objects per territory. There
is no key to leak and nothing metered per lead.

## Gates

- `npm run verify:addresses` — tile arithmetic (the tiler and the Worker agree),
  the duplicate and erased rules, the cap, the refusals; no bucket, no database.
- `npm run smoke:territory-leads` — a real Worker over a real D1 and a local
  R2: tiles put the way `--upload` puts them, a territory drawn with the box
  ticked, a rep's phone checked, a second press, an erased homeowner, and the
  501 a deployment without the binding answers.
