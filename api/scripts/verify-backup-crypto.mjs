import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decryptFile,
  encryptFile,
  isEncryptedBackup,
  loadBackupKey,
  MIN_SECRET_CHARS,
  NoBackupKey,
  readBackupHeader,
} from './lib/backup-crypto.mjs'

/**
 * Prove the backup encryption refuses what it is supposed to refuse.
 *
 * The happy path is the easy half and the half that does not matter much: if
 * encrypt-then-decrypt were broken it would be obvious the first time anyone
 * tried it. Every failure that costs something is a refusal that did not
 * happen —
 *
 *   a dump exported in the clear because no key was configured
 *   a truncated or altered file that restores anyway, up to the cut
 *   a header rewritten so the file can never be opened again
 *   a plaintext dump left staged on disk after the run
 *   a key short enough to guess, accepted quietly
 *
 * — and each of those passes a round-trip test. So this asserts the refusals
 * individually, and each one has been confirmed by breaking the code and
 * watching this fail.
 *
 * Runs entirely in a temporary directory. `backup.mjs` is exercised as a copy in
 * that directory rather than in place, which is what makes the "no key
 * configured" case testable at all: the key file's path is derived from the
 * script's own location, so a copy in a scratch tree is a deployment with no key
 * — without adding an override to production code whose only purpose is to let a
 * test disable the safety.
 *
 *   npm run verify:backups
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const KEY = 'zC8jK2pQ7wR4tY6uI9oP1aS3dF5gH0jK2lZ8xC4vB6n='
const OTHER = 'Q9wE7rT5yU3iO1pA8sD6fG4hJ2kL0zX9cV7bN5mQ3wE='

const scratch = mkdtempSync(join(tmpdir(), 'allstar-backupcrypto-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

/*
  A marker that appears nowhere in the container format, so finding it in the
  output can only mean the bytes went through unencrypted. Shaped like the data
  this is protecting, because that is what would actually be in there.
*/
const MARKER = 'Wilhelmina Ackerbridge, 4417 Sundapple Terrace, 505-867-5309'
const dump =
  `PRAGMA foreign_keys=OFF;\nCREATE TABLE IF NOT EXISTS contacts (id TEXT, note TEXT);\n` +
  `INSERT INTO contacts VALUES ('1','${MARKER}');\n`.repeat(40) +
  `COMMIT;\n`

const plain = join(scratch, 'dump.sql')
writeFileSync(plain, dump)

/* --- 1. it round-trips, and it actually encrypted -------------------------- */

const enc = join(scratch, 'dump.sql.enc')
const { header } = await encryptFile({
  plainPath: plain,
  outPath: enc,
  secret: KEY,
  source: 'allstar-db (test)',
})

const encBytes = readFileSync(enc)
ok(isEncryptedBackup(enc), 'the written file identifies itself as an Allstar backup')
ok(
  !encBytes.includes(Buffer.from(MARKER)),
  'and the customer data is not sitting in it in the clear',
  `${encBytes.length} bytes searched`,
)
ok(
  !encBytes.includes(Buffer.from('CREATE TABLE')),
  'nor is the schema',
)

const back = join(scratch, 'back.sql')
await decryptFile({ path: enc, outPath: back, secret: KEY })
ok(readFileSync(back, 'utf8') === dump, 'and it decrypts to exactly what went in')

/* --- 2. the header is readable without the key ----------------------------- */
//
// Not a nicety. If a directory of .enc files cannot be told apart without first
// opening them, a recovery starts by guessing which file is which — and the one
// thing worse than no backup is restoring last month's over this morning's.
const seen = readBackupHeader(enc).header
ok(seen.created === header.created && seen.source === 'allstar-db (test)', 'the header reads without a key')
ok(seen.plainBytes === statSync(plain).size, 'and records the size of the SQL inside it', `${seen.plainBytes} bytes`)
ok(!JSON.stringify(seen).includes(KEY.slice(0, 12)), 'and does not carry the key itself')

/* --- 3. every way a file can be wrong ------------------------------------- */
//
// One helper, so each case asserts the same two things: it refuses, and it
// leaves no plaintext behind. The second half is the one that would go
// unnoticed — a decrypt that throws after writing a partial file gives a dump
// that restores cleanly up to the cut, which is indistinguishable from a good
// restore until somebody opens the one record that is missing.
async function mustRefuse(label, mutate, secret = KEY) {
  const file = join(scratch, `case-${label.replace(/\W+/g, '-')}.enc`)
  copyFileSync(enc, file)
  mutate(file)
  const out = `${file}.out`
  let threw = null
  try {
    await decryptFile({ path: file, outPath: out, secret })
  } catch (err) {
    threw = err
  }
  ok(threw !== null, `refuses ${label}`, threw ? String(threw.message).split('\n')[0] : 'DECRYPTED IT')
  ok(!existsSync(out), `and writes no plaintext when refusing ${label}`)
  ok(!existsSync(`${out}.partial`), `and leaves no partial file behind for ${label}`)
}

await mustRefuse('the wrong key', () => {}, OTHER)

await mustRefuse('a single flipped byte in the ciphertext', (file) => {
  const buf = readFileSync(file)
  // Past the header, before the tag — the body itself.
  const at = readBackupHeader(file).preambleLength + 8
  buf[at] ^= 0x01
  writeFileSync(file, buf)
})

await mustRefuse('a truncated file', (file) => {
  const buf = readFileSync(file)
  writeFileSync(file, buf.subarray(0, buf.length - 120))
})

await mustRefuse('a missing authentication tag', (file) => {
  const buf = readFileSync(file)
  writeFileSync(file, buf.subarray(0, buf.length - 16))
})

/*
  The header is plaintext, so it can be edited. It is fed to GCM as additional
  authenticated data specifically so that editing it fails — without that, the
  salt and the KDF parameters sit outside the authentication and anyone can turn
  every future restore into an unexplained error.
*/
await mustRefuse('an edited header', (file) => {
  const { header: h, preambleLength } = readBackupHeader(file)
  const buf = readFileSync(file)
  const body = buf.subarray(preambleLength)
  const edited = { ...h, created: '1999-01-01T00:00:00.000Z' }
  const rebuilt = Buffer.from(`ALLSTAR-BACKUP-1\n${JSON.stringify(edited)}\n`, 'utf8')
  writeFileSync(file, Buffer.concat([rebuilt, body]))
})

await mustRefuse('a header whose scrypt parameters were swapped', (file) => {
  const { header: h, preambleLength } = readBackupHeader(file)
  const buf = readFileSync(file)
  const body = buf.subarray(preambleLength)
  const rebuilt = Buffer.from(`ALLSTAR-BACKUP-1\n${JSON.stringify({ ...h, N: 1024 })}\n`, 'utf8')
  writeFileSync(file, Buffer.concat([rebuilt, body]))
})

/* --- 4. a key too short to be one ----------------------------------------- */
//
// The failure here is not brute force, it is vocabulary: a file encrypted under
// "test" is one everybody involved will describe as encrypted, and nothing in
// the filename, the header or the restore drill would ever contradict them.
{
  const saved = process.env.BACKUP_KEY
  // A distinctive value rather than something like "short", so that finding it
  // in the error message means the message leaked the key and cannot instead be
  // the word appearing in the surrounding prose.
  const TOO_SHORT = 'hunter2-zx9'
  process.env.BACKUP_KEY = TOO_SHORT
  let threw = null
  try {
    loadBackupKey()
  } catch (err) {
    threw = err
  }
  ok(threw instanceof NoBackupKey, 'a key shorter than the minimum is refused, not accepted quietly', `minimum ${MIN_SECRET_CHARS}, given ${TOO_SHORT.length}`)
  ok(
    threw !== null && !String(threw.message).includes(TOO_SHORT),
    'and the refusal names the length without echoing the key back',
  )

  process.env.BACKUP_KEY = KEY
  const loaded = loadBackupKey()
  ok(loaded?.secret === KEY, 'a real key loads from the environment', loaded?.where)
  if (saved === undefined) delete process.env.BACKUP_KEY
  else process.env.BACKUP_KEY = saved
}

/* --- 5. backup.mjs refuses rather than writing plaintext ------------------ */
//
// Run as a copy in a scratch tree. The key file's path comes from the script's
// own location, so a copy is a deployment with no key configured — the state a
// fresh machine is in, and the one where writing the dump anyway would be worst.

const fakeApi = join(scratch, 'api')
mkdirSync(join(fakeApi, 'scripts', 'lib'), { recursive: true })
copyFileSync(join(api, 'scripts/backup.mjs'), join(fakeApi, 'scripts/backup.mjs'))
copyFileSync(
  join(api, 'scripts/lib/backup-crypto.mjs'),
  join(fakeApi, 'scripts/lib/backup-crypto.mjs'),
)
const fakeBackups = join(fakeApi, 'backups')

function runBackup(args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [join(fakeApi, 'scripts/backup.mjs'), ...args], {
      cwd: fakeApi,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BACKUP_KEY: '', ...env },
    })
    return { code: 0, out }
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    }
  }
}

/*
  A refusal is not "it exited non-zero". In this scratch tree there is no
  wrangler, so *everything* exits non-zero — a run that sails past the key check
  and dies on a missing binary looks identical to one that refused, and an
  exit-code-only assertion passes happily on a build that would have exported
  the plaintext. Confirmed: removing the production `--plaintext` refusal left
  the gate green until this was tightened.

  So a refusal has to prove two things. Exit 2, which is the code this script
  uses for "declined on purpose" and never for a crash. And no "Exporting" line,
  because that is printed immediately before the export runs — its absence is
  the evidence that nothing was sent to the database, which is the property that
  actually matters.
*/
const refused = (label, run) => {
  ok(run.code === 2, label, `exit ${run.code}`)
  ok(!/Exporting/.test(run.out), `and nothing was exported before ${label}`)
}

const noKey = runBackup([])
refused('backup.mjs refuses to export production with no key configured', noKey)
ok(/openssl rand -base64 32/.test(noKey.out), 'and says how to generate one')
ok(
  !existsSync(fakeBackups) || readdirSync(fakeBackups).length === 0,
  'and writes nothing at all — not even an empty file',
)

refused('--plaintext cannot be used against production', runBackup(['--plaintext']))

/*
  With a key, it gets as far as the export and the export fails — there is no
  wrangler in this scratch tree. That is the case worth testing: by then the
  staging directory for the plaintext dump has been created, so whether it is
  cleaned up on a failure is a real question rather than a structural one.
*/
const exportFails = runBackup([], { BACKUP_KEY: KEY })
ok(exportFails.code !== 0, 'a failed export is reported as a failure', `exit ${exportFails.code}`)
const leftovers = existsSync(fakeBackups)
  ? readdirSync(fakeBackups).filter((f) => f.startsWith('.staging-') || f.endsWith('.partial'))
  : []
ok(
  leftovers.length === 0,
  'and a failed export leaves no staged plaintext behind',
  leftovers.length ? leftovers.join(', ') : 'nothing staged',
)

/* --- 6. the order of the two checks in backup.mjs ------------------------- */
//
// Structural, and the only one of these that is. The refusal has to happen
// before the export runs: an export that succeeds and *then* discovers there is
// nowhere safe to put the result has already written the plaintext to disk, and
// no amount of refusing afterwards unwrites it. Round-trip tests cannot see this
// and neither can the run above, because both orderings exit non-zero.
{
  const src = readFileSync(join(api, 'scripts/backup.mjs'), 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ')
  /*
    The call, `loadBackupKey()`, and not the bare identifier. The identifier also
    appears in the import at the top of the file, which is always before
    everything — so the first version of this check could not fail, and did not,
    when the key check was deliberately moved below the export.
  */
  const keyCheck = stripped.indexOf('loadBackupKey()')
  const exportCall = stripped.indexOf("'export'")
  ok(keyCheck >= 0, 'backup.mjs calls loadBackupKey()')
  ok(exportCall >= 0, 'and calls wrangler d1 export')
  ok(
    keyCheck >= 0 && exportCall >= 0 && keyCheck < exportCall,
    'and decides about the key BEFORE exporting anything',
    `key at ${keyCheck}, export at ${exportCall}`,
  )
}

/* --- 7. the key is not something you can pass on the command line -------- */
//
// A secret in argv is a secret in the shell history, in `ps` for the length of
// the run, and in any log that echoes the command that produced it.
{
  const src = readFileSync(join(api, 'scripts/lib/backup-crypto.mjs'), 'utf8')
  ok(
    !/argv/.test(src),
    'the key is never read from argv — only the environment or the key file',
  )
  const ignored = readFileSync(resolve(api, '../.gitignore'), 'utf8')
  ok(/^api\/\.backup-key$/m.test(ignored), 'and the key file is git-ignored')
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== backup encryption OK — it refuses everything it should ===')
