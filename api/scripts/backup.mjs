import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encryptFile, keySetupHelp, loadBackupKey, NoBackupKey } from './lib/backup-crypto.mjs'

/**
 * Take a logical backup of the production database, encrypted.
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
 * Under the encryption it is plain SQL. It restores into D1, into SQLite, or
 * into anything that speaks the dialect, which matters because "we can restore"
 * should not depend on one vendor still being willing to serve you.
 *
 *   npm run backup                              # production → backups/*.sql.enc
 *   node scripts/backup.mjs --local             # the local dev database
 *   node scripts/backup.mjs --out /some/path.sql.enc
 *   node scripts/backup.mjs --local --plaintext # dev only, and it has to be asked for
 *
 * ## Why this refuses to run without a key
 *
 * The file holds every customer's addresses, contact names and phone numbers,
 * plus password hashes. `backups/` is git-ignored, which keeps it off GitHub and
 * does precisely nothing about the copy that ends up on a laptop, in a Downloads
 * folder, or in whatever cloud drive that laptop syncs to — and the file exists
 * in order to be copied somewhere else. Encryption is the only control that
 * survives it leaving this machine.
 *
 * So when there is no key, this stops and says how to make one. It does not
 * write the plaintext "for now": a backup nobody meant to leave unencrypted is
 * how every one of these ends up unencrypted, and the file would be indexed,
 * synced and forgotten long before anyone came back to it. The same posture as
 * `INTEGRATION_KEY` in the Worker — no key, no operation.
 *
 * `--plaintext` exists for the local dev database and refuses on production,
 * because the local one holds generated seed data and gets fed to the restore
 * drill by hand.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const wrangler = resolve(api, 'node_modules/.bin/wrangler')
const DB = 'allstar-db'

const args = process.argv.slice(2)
const local = args.includes('--local')
const plaintext = args.includes('--plaintext')
const outFlag = args.indexOf('--out')

/* --- the key, before anything else ---------------------------------------- */
//
// Checked first, and deliberately before the export runs. Exporting and *then*
// discovering there is nowhere safe to put the result would leave the plaintext
// on disk anyway — which is the outcome this whole file exists to prevent.

let key = null
if (!plaintext) {
  try {
    key = loadBackupKey()
  } catch (err) {
    if (err instanceof NoBackupKey) {
      console.error(`\n${err.message}`)
      process.exit(2)
    }
    throw err
  }
  if (!key) {
    console.error(`\n${keySetupHelp()}\n`)
    console.error(
      local
        ? `\nFor the local dev database only, --plaintext skips this.\n`
        : `\nNothing was exported. This is not a "for now" you can skip: the file would\n` +
            `hold every customer's addresses, phone numbers and password hashes.\n`,
    )
    process.exit(2)
  }
} else if (!local) {
  console.error(
    `\n--plaintext is refused against production.\n\n` +
      `That file would hold every customer's addresses, contact names, phone numbers\n` +
      `and password hashes, in the clear, in a file whose purpose is to be copied\n` +
      `somewhere else. If the key is the problem, fix the key:\n\n${keySetupHelp()}\n`,
  )
  process.exit(2)
}

/*
  A UTC timestamp, and seconds included on purpose: two exports on the same day
  during an incident must not silently overwrite each other, and an incident is
  exactly when someone runs this twice in five minutes.
*/
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z')
const defaultName = `${DB}-${stamp}.sql${key ? '.enc' : ''}`
const out = outFlag >= 0 ? resolve(args[outFlag + 1]) : resolve(api, 'backups', defaultName)

mkdirSync(dirname(out), { recursive: true })

/*
  `wrangler d1 export` writes plaintext to a path it is given — there is no way
  to have it hand back a stream — so the plaintext exists on disk for the length
  of one encryption no matter how this is arranged. What can be controlled is
  where, for how long, and who can read it.

  Staged inside the destination directory rather than /tmp: same filesystem, so
  the space check that matters is the one the operator already made, and it is
  inside the git-ignored `backups/` tree rather than a world-traversable
  directory. mkdtemp creates it 0700, so the dump is readable by this user only,
  and the finally below removes it on every path out of here including a crash.
*/
const staging = key ? mkdtempSync(join(dirname(out), '.staging-')) : null
const raw = staging ? join(staging, 'dump.sql') : out

const cleanup = () => {
  if (staging) rmSync(staging, { recursive: true, force: true })
}

/*
  Thrown rather than exited on, because `process.exit()` skips pending `finally`
  blocks — and the finally below is what deletes the staged plaintext. Exiting
  directly from inside the try would leave an unencrypted dump on disk on
  precisely the path that has already decided something went wrong.
*/
class ExportRefused extends Error {}
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

console.log(`Exporting ${DB} (${local ? 'local' : 'REMOTE — production'}) → ${out}`)

try {
  execFileSync(
    wrangler,
    ['d1', 'export', DB, local ? '--local' : '--remote', '--output', raw],
    { cwd: api, stdio: 'inherit' },
  )

  const rawBytes = statSync(raw).size

  /*
    An empty or near-empty dump is the failure this catches. `wrangler d1 export`
    exits 0 having written a file containing nothing but a couple of PRAGMAs when
    it cannot reach the data, and a backup routine that reports success on that is
    worse than no backup routine — somebody deletes the old one.

    Checked on the plaintext, before encrypting, because afterwards every file
    looks like incompressible noise of a plausible size.
  */
  if (rawBytes < 512) {
    throw new ExportRefused(
      `That export is ${rawBytes} bytes — too small to be a database. Treat this run as\n` +
        `FAILED and do not delete an earlier backup on the strength of it.`,
    )
  }

  if (key) {
    process.stdout.write(`\nEncrypting with the key from ${key.where}… `)
    const { bytes } = await encryptFile({
      plainPath: raw,
      outPath: out,
      secret: key.secret,
      source: `${DB} (${local ? 'local' : 'remote'})`,
    })
    console.log(`done`)
    console.log(`\nWrote ${(bytes / 1024).toFixed(1)} KB encrypted (${(rawBytes / 1024).toFixed(1)} KB of SQL)`)
  } else {
    console.log(`\nWrote ${(rawBytes / 1024).toFixed(1)} KB of PLAINTEXT SQL`)
  }
} catch (err) {
  cleanup()
  if (err instanceof ExportRefused) {
    console.error(`\n${err.message}`)
    process.exit(1)
  }
  throw err
} finally {
  cleanup()
}

console.log(
  `\nNext: prove it restores.\n` +
    `  node scripts/verify-restore.mjs "${out}"\n`,
)

if (key) {
  console.log(
    `This file is encrypted, and the key is not in it. Without the key from\n` +
      `${key.where} it is unreadable — by an attacker, and by you.\n` +
      `Keep that key somewhere that is not this machine.`,
  )
} else {
  console.log(
    `THIS FILE IS NOT ENCRYPTED. It holds addresses, contact details and password\n` +
      `hashes in the clear. It is dev data, so that is a decision rather than an\n` +
      `accident — but do not copy it anywhere, and delete it when you are done.`,
  )
}
