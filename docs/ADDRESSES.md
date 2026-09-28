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

## What does not become a lead

- An address that is already a lead in this company, by the same normalised key
  the CSV import uses, or one within about 12 m of an existing lead with the
  same house number — two spellings of one door.
- A homeowner who was erased. A redraw does not resurrect them.
- Anything past 5,000 new leads in one call. The call still succeeds and says
  how many it skipped; draw the rest as a second territory.
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

2. In `wrangler.toml`, uncomment the three lines under *The houses on the
   ground* so the Worker binds `ADDRESSES` to it. Deploy (a merge does that).
   `wrangler deploy` refuses a binding whose bucket does not exist, and this
   repo deploys on every merge — which is why the binding ships commented out
   and the bucket comes first.

3. Build and upload the ground you sell on, as a bounding box
   (`minLng,minLat,maxLng,maxLat`). Austin's metro, for example:

       npm run addresses:build -- --bbox -98.10,30.05,-97.45,30.65 --upload

   That reads about forty row groups, takes a few minutes, and uploads a few
   thousand tiles. Repeat for each market. Re-running over the same box
   rewrites the same tiles; a neighbouring box adds more. Tiles never merge
   across runs, so build each box whole rather than in strips.

   `--upload` needs `wrangler login` or `CLOUDFLARE_API_TOKEN` with R2 write
   access. Without `--upload` the tiles are written to `./addr-tiles` for a
   look first. `--release YYYY-MM-DD.N` pins an Overture release; the default
   is the newest.

4. Check: `/api/health` reports `config.addresses: true`, and drawing a
   territory in the console offers **Find the houses inside and add them as
   leads**, ticked by default.

Refreshing the data is step 3 again with a newer release. New houses on a
street that was already built appear on the next **Find addresses**.

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
