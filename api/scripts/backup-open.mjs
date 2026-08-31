import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decryptFile,
  isEncryptedBackup,
  keySetupHelp,
  loadBackupKey,
  NoBackupKey,
  readBackupHeader,
} from './lib/backup-crypto.mjs'

/**
 * Read an encrypted backup: list what you have, or decrypt one to restore from.
 *
 * The restore drill (`verify-restore.mjs`) decrypts on its own and cleans up
 * after itself, so this is not needed to *test* a backup. It is needed for the
 * real thing, and for the question that comes first in a real recovery: which of
 * these forty files do I want?
 *
 *   node scripts/backup-open.mjs --list
 *   node scripts/backup-open.mjs backups/allstar-db-….sql.enc
 *   node scripts/backup-open.mjs <file> --out /somewhere/restore.sql
 *
 * `--list` needs no key. The header is stored in the clear precisely so that a
 * directory of encrypted files stays legible — what it is, when it was taken,
 * how large the database was. A backup nobody can identify without first
 * decrypting it is a backup that gets restored from the wrong day.
 *
 * Decrypting writes plaintext to disk, which is the thing everything else here
 * works to avoid, so it says so plainly and defaults to a path next to the
 * encrypted file rather than somewhere that gets forgotten.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const BACKUPS = resolve(api, 'backups')

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const positional = args.filter((a, i) => !a.startsWith('--') && i !== outFlag + 1)

const kb = (n) => `${(n / 1024).toFixed(1)} KB`

/* --- --list ---------------------------------------------------------------- */

if (args.includes('--list')) {
  const dir = positional[0] ? resolve(positional[0]) : BACKUPS
  if (!existsSync(dir)) {
    console.error(`No backups directory at ${dir}. Nothing has been exported here yet.`)
    process.exit(1)
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') || f.endsWith('.sql.enc'))
    .sort()

  if (files.length === 0) {
    console.error(`No backups in ${dir}.`)
    process.exit(1)
  }

  console.log(`${files.length} in ${dir}\n`)
  for (const f of files) {
    const full = join(dir, f)
    const onDisk = statSync(full).size
    if (!isEncryptedBackup(full)) {
      // Called out rather than listed neutrally. A plaintext dump sitting in
      // this directory is a live exposure, not a format variant.
      console.log(`  ${f}\n      PLAINTEXT — ${kb(onDisk)}, unencrypted, readable by anyone with the file`)
      continue
    }
    try {
      const { header } = readBackupHeader(full)
      console.log(
        `  ${f}\n` +
          `      taken ${header.created}  ·  ${header.source ?? 'unknown source'}\n` +
          `      ${kb(header.plainBytes)} of SQL, ${kb(onDisk)} encrypted`,
      )
    } catch (err) {
      console.log(`  ${f}\n      UNREADABLE — ${err.message}`)
    }
  }
  console.log(
    `\nThese are headers only — no key was used and nothing was decrypted, so this\n` +
      `says what each file claims to be, not that it opens. Only the restore drill\n` +
      `proves that:  node scripts/verify-restore.mjs <file>`,
  )
  process.exit(0)
}

/* --- decrypt one ----------------------------------------------------------- */

const target = positional[0]
if (!target) {
  console.error(
    `Usage:\n` +
      `  node scripts/backup-open.mjs --list\n` +
      `  node scripts/backup-open.mjs <backup.sql.enc> [--out restore.sql]\n`,
  )
  process.exit(2)
}

const path = resolve(target)
if (!existsSync(path)) {
  console.error(`No such file: ${path}`)
  process.exit(1)
}

if (!isEncryptedBackup(path)) {
  console.error(
    `${path}\nis not an encrypted backup — it has no Allstar header. If it is a plain\n` +
      `.sql dump you can restore from it directly; there is nothing to open.`,
  )
  process.exit(1)
}

let key
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
  console.error(
    `\nThat file is encrypted and no key is configured, so it cannot be opened.\n\n${keySetupHelp()}\n\n` +
      `If the key it was written with is gone, this file cannot be recovered by any\n` +
      `part of this project. That is the trade encryption makes.`,
  )
  process.exit(2)
}

const { header } = readBackupHeader(path)
const out = outFlag >= 0 ? resolve(args[outFlag + 1]) : path.replace(/\.enc$/, '')

if (existsSync(out)) {
  // Refused rather than overwritten. During a recovery the file already sitting
  // there is as likely to be the good copy as the stale one.
  console.error(`${out} already exists. Move it or pass --out somewhere else.`)
  process.exit(1)
}

console.log(
  `Opening ${path}\n` +
    `  taken ${header.created}  ·  ${header.source ?? 'unknown source'}  ·  ${kb(header.plainBytes)} of SQL\n` +
    `  key from ${key.where}\n`,
)

try {
  const { bytes } = await decryptFile({ path, outPath: out, secret: key.secret })
  console.log(`Wrote ${kb(bytes)} of plaintext SQL → ${out}`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exit(1)
}

console.log(
  `\nThat file is now unencrypted on this disk: addresses, contact details and\n` +
    `password hashes in the clear. Restore from it, prove it, then delete it —\n` +
    `the encrypted copy is the one that gets to survive.\n\n` +
    `  node scripts/verify-restore.mjs "${out}"`,
)
