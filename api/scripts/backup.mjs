import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Take a logical backup of the production database.
 *
 * D1 already has Time Travel, which is automatic and covers the disaster people
 * actually cause: someone runs the wrong UPDATE and it needs undoing an hour
 * later. This exists for the two it does not cover.
 *
 *   Time Travel is bounded — thirty days. A corruption discovered in month two
 *   is a corruption Time Travel cannot reach past.
 *
 *   Time Travel lives inside the account. A closed, compromised, or
 *   mis-billed Cloudflare account takes it with it. A backup you cannot hold
 *   in your hand is a backup that shares the fate of the thing it protects.
 *
 * The output is plain SQL. It restores into D1, into SQLite, or into anything
 * that speaks the dialect, which matters because "we can restore" should not
 * depend on one vendor still being willing to serve you.
 *
 *   node scripts/backup.mjs                     # production, to backups/
 *   node scripts/backup.mjs --local             # the local dev database
 *   node scripts/backup.mjs --out /some/path.sql
 *
 * The file is NOT committed. It contains every customer's addresses, contact
 * names and phone numbers, plus password hashes — `backups/` is git-ignored, and
 * the file wants encrypting before it goes anywhere.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const wrangler = resolve(api, 'node_modules/.bin/wrangler')
const DB = 'allstar-db'

const args = process.argv.slice(2)
const local = args.includes('--local')
const outFlag = args.indexOf('--out')

/*
  A UTC timestamp, and seconds included on purpose: two exports on the same day
  during an incident must not silently overwrite each other, and an incident is
  exactly when someone runs this twice in five minutes.
*/
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z')
const out =
  outFlag >= 0 ? resolve(args[outFlag + 1]) : resolve(api, 'backups', `${DB}-${stamp}.sql`)

mkdirSync(dirname(out), { recursive: true })

console.log(`Exporting ${DB} (${local ? 'local' : 'REMOTE — production'}) → ${out}`)

execFileSync(
  wrangler,
  ['d1', 'export', DB, local ? '--local' : '--remote', '--output', out],
  { cwd: api, stdio: 'inherit' },
)

const bytes = statSync(out).size
console.log(`\nWrote ${(bytes / 1024).toFixed(1)} KB`)

/*
  An empty or near-empty dump is the failure this catches. `wrangler d1 export`
  exits 0 having written a file containing nothing but a couple of PRAGMAs when
  it cannot reach the data, and a backup routine that reports success on that is
  worse than no backup routine — somebody deletes the old one.
*/
if (bytes < 512) {
  console.error(
    `\nThat file is too small to be a database. Treat this run as FAILED and do not\n` +
      `delete an earlier backup on the strength of it.`,
  )
  process.exit(1)
}

console.log(
  `\nNext: prove it restores.\n` +
    `  node scripts/verify-restore.mjs "${out}"\n\n` +
    `This file holds customer addresses, contact details and password hashes.\n` +
    `Encrypt it before it goes anywhere, and do not commit it.`,
)
