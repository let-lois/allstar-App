# Backups, in plain terms

Written because "are we backed up?" turned out to be a question nobody could
answer from the console, even though the answer is yes and has been for a while.
Everything below is what the code actually does — file and line references
included, so this can be checked rather than believed.

## The short answer

Three independent copies of the database exist, and they fail in different ways
on purpose.

| | What it is | When | Survives |
|---|---|---|---|
| **D1 Time Travel** | Cloudflare's own point-in-time restore | continuous, 30-day window | a wrong `UPDATE`, undone an hour later |
| **Nightly cron** | An encrypted dump written to R2 by the Worker | 07:17 UTC daily (`api/wrangler.toml`) | everybody being busy |
| **`npm run backup`** | The same encrypted dump, written to a laptop | whenever somebody runs it | the Cloudflare account itself being closed, compromised or mis-billed |

The second and third write **byte-for-byte the same file format**, which is the
reason the restore drill means anything: `npm run backup:open` and
`node scripts/verify-restore.mjs` read what the cron writes, with no flag and no
special case. A separate format for the scheduled backup would be a second thing
to keep working, and it would be discovered broken during a restore.

Time Travel is not a replacement for either. It covers the incident people
actually cause and covers it better. The other two exist for the month-two
corruption nobody noticed, and for the lost account.

## What is in a backup

Every table in D1: companies, users and password hashes, properties, contacts,
visits, notes, photo metadata, lists, territories, the audit log. Cloudflare's
own bookkeeping tables are skipped — they are not ours to restore.

**Photos themselves are not in it.** They live in the `PHOTOS` R2 bucket, which
is a separate bucket with its own durability and is not dumped by this. A
restore brings back every lead, every visit and every note; it brings back the
*record* of a photo and not the image.

## Where it lands, and what it costs

R2 bucket `allstar-backups`, one object per night, named
`allstar-db-<ISO timestamp>.sql.enc` — seconds in the name and UTC, so two
backups on one day cannot overwrite each other, and a day with two on it is a
day something went wrong.

**Nothing prunes them.** There is no lifecycle rule in this repo and no delete
path in `api/src/backup.ts`, so the bucket grows by one dump a night forever. At
this database's size that is pennies a year and not worth acting on yet; it is
written down here so it is a decision rather than an oversight. If it ever
matters, an R2 lifecycle rule on the bucket is the right place for it, not code.

## Encryption, and the one way to lose everything

Every dump is AES-256-GCM, keyed from the `BACKUP_KEY` Worker secret.

> **`BACKUP_KEY` must never be rotated.** Every backup already written with the
> old key becomes permanently unreadable, and nothing in this project can
> recover them. It must also be the *same* value as `api/.backup-key` on the
> machine that runs `npm run backup`, so that one key opens both sets of files.

Without the secret the nightly backup refuses to run and logs why. That is
deliberate: the alternative is an unencrypted dump of every customer's
addresses, contact names, phone numbers and password hashes sitting in a bucket.

## How to check it is actually happening

Two different questions, and only one of them is usually asked.

`GET /api/health` reports `backupBucket` and `backupKey`. Those say the
*configuration* is present, and they stay `true` through a cron that stopped
firing, a `put` that threw every night, and a bucket somebody emptied. This
project has already read `backupKey: true` beside a log line saying no backup
was taken.

`GET /api/ops/backups` — the **Backups** panel on the platform screen — reports
the newest object actually in the bucket, its size, and how long ago it landed.
That is the question worth asking, and the age is the point: "nine hours ago"
and "nineteen days ago" are different facts that presence cannot tell apart.

It is super-admin only, and on the platform screen rather than a company's,
because the dump is every customer's data and its size over time describes that
database.

## How to restore

Order matters. Do not restore into the live database to "see if it works".

1. **Get the file.** From the bucket
   (`npx wrangler r2 object get allstar-backups/allstar-db-….sql.enc`) or from
   the laptop copy in `api/backups/`.
2. **Prove it is whole, into a scratch database:**
   ```
   cd api && node scripts/verify-restore.mjs backups/allstar-db-….sql.enc
   ```
   This decrypts, restores into a throwaway SQLite file, and checks the schema
   and the foreign keys came back intact. It never touches production — a
   restore test that can damage the live database is a second disaster waiting
   behind the first. **Run this on a schedule, not during an incident.** An
   untested backup fails in exactly one way: you find out at the worst moment.
3. **Only then** decide whether the incident wants Time Travel (almost always,
   for anything inside 30 days) or a full restore from the dump.

## What is not covered

- **Photos.** Separate bucket, not in the dump.
- **Secrets.** `SESSION_PEPPER`, `BACKUP_KEY`, API keys — none are in a backup,
  by design. Keep them where the Cloudflare account is not the only copy.
- **A consistent instant.** D1 has no transaction spanning several statements
  over the wire, so a dump is a set of reads taken over a few seconds rather
  than a snapshot. It runs at 3am local when nobody is knocking, and it goes
  through a D1 session so every read is served by the primary in order. See the
  header of `api/src/backup.ts` for the full reasoning.
