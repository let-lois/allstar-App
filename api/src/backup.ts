import type { Env } from './types'

/**
 * The database, backed up on Cloudflare's clock instead of somebody's memory.
 *
 * `api/scripts/backup.mjs` already takes an encrypted dump, and it is the better
 * tool: it runs `wrangler d1 export`, which is Cloudflare's own export path, and
 * it writes the file onto a machine that is not the account being backed up.
 * What it cannot do is happen on a Tuesday when nobody thought about it. Every
 * backup this project had, up to here, existed because a person remembered — and
 * the failure mode of that arrangement is not visible until the day it matters,
 * when the most recent file turns out to be from whenever somebody last had a
 * reason to think about backups.
 *
 * So this is the unattended half, and the two are not redundant:
 *
 *   the laptop script is the *off-account* copy — it survives a closed,
 *   compromised or mis-billed Cloudflare account, which is the failure R2 shares
 *   with D1 because they are the same account
 *
 *   this is the *unattended* copy — it survives everyone being busy, which is
 *   the failure the laptop script has never survived
 *
 * Neither replaces D1's Time Travel, which is automatic, point-in-time, and
 * bounded at thirty days. Time Travel covers the incident people actually cause
 * (a wrong UPDATE, undone an hour later) and covers it better than either of
 * these. These two exist for the month-two corruption and the lost account.
 *
 * ## The file is the same file
 *
 * Byte-for-byte the same container `backup.mjs` writes — magic line, plaintext
 * authenticated header, AES-256-GCM body, tag — derived with the same scrypt
 * parameters from the same `BACKUP_KEY`. That is the whole reason this was worth
 * doing inside the Worker rather than inventing a second format: `npm run
 * backup:open` and `node scripts/verify-restore.mjs` read what the cron writes
 * with no flag and no branch, so the restore drill exercises the scheduled
 * backup rather than a cousin of it. A second format would be a second thing to
 * keep working, discovered to be broken during a restore.
 *
 * Only the key derivation comes from `node:crypto` — `scryptSync`, under
 * `nodejs_compat`. Everything else is Web Crypto, which is native rather than
 * shimmed and happens to fit the format exactly: `subtle.encrypt` with AES-GCM
 * returns the ciphertext with its 16-byte tag already appended, which is the
 * layout the container wants, and takes the authenticated header as
 * `additionalData`. The first draft used `createCipheriv` for symmetry with the
 * Node script and got `[unenv] crypto.createCipheriv is not implemented yet` out
 * of local dev — worth knowing before reaching for another `node:` primitive
 * here: the shim's coverage is not the same as Node's.
 *
 * ## What this is not: a snapshot
 *
 * D1 has no transaction spanning several statements over the wire, so a dump
 * assembled from one SELECT per table is a set of reads taken over a few
 * seconds, not a consistent instant. A row written between the read of
 * `properties` and the read of `visits` lands in one and not the other.
 *
 * Three things keep that from being a problem rather than pretending it is not
 * one. It runs in the small hours, when nobody is knocking. It goes through a D1
 * *session*, so every read is served by the primary in order, and the dump can
 * never be assembled from a mix of stale replicas — the failure that would look
 * like data loss and be nothing of the kind. And the dump opens with
 * `PRAGMA defer_foreign_keys=true`, so a child that arrived without its parent
 * restores instead of aborting the whole file at that row.
 *
 * If you need an exact instant, that is Time Travel, and it is one command.
 */

/* --- the schedule ---------------------------------------------------------- */

/**
 * Once a day at 07:17 UTC — a little after 3am on the east coast, which is the
 * quietest hour for a company whose reps knock on doors.
 *
 * Deliberately not a multiple of five. The every-five-minute expression below is
 * the CRM drain, and a shared minute would be two schedules firing at once, each
 * getting its own invocation. At :17 the drain has already run at :15 and runs
 * again at :20, so adding this skips nothing.
 *
 * Exported because `scheduled()` branches on it and the gate fires it by name —
 * a literal typed in three places is a literal that eventually differs in one.
 */
export const BACKUP_CRON = '17 7 * * *'

/** The CRM drain's schedule, here for the same reason. */
export const DRAIN_CRON = '*/5 * * * *'

/* --- limits ---------------------------------------------------------------- */

/**
 * Below this, treat the run as failed.
 *
 * The same threshold and the same reasoning as `backup.mjs`: an export that
 * could not reach the data still produces a file, and a backup routine that
 * reports success on it is worse than no backup routine, because somebody
 * deletes the older one on the strength of it.
 */
const MIN_PLAIN_BYTES = 512

/**
 * Above this, refuse loudly rather than write something.
 *
 * A Worker has 128 MB of memory and this holds the dump and its ciphertext at
 * once. The honest failure is a run that stops and says the database has
 * outgrown it; the dishonest one is a truncated file that restores cleanly up to
 * the cut. When this trips, the answer is `npm run backup` from a machine, and
 * that message is in the error.
 *
 * Enforced while the dump is being built rather than on the finished string —
 * a ceiling checked after the memory has been taken is a ceiling that reports
 * nothing, because the isolate is already gone. See `push` in `dumpDatabase`.
 */
export const MAX_PLAIN_BYTES = 40 * 1024 * 1024

/** Rows per read. Bounds the response size without making the dump chatty. */
const PAGE = 500

/* --- the dump -------------------------------------------------------------- */

interface SchemaObject {
  type: string
  name: string
  sql: string
}

/** Cloudflare's own bookkeeping. It is not ours to back up, or to restore. */
const isInternal = (name: string) => /^(sqlite_|_cf_)/i.test(name)

/** One SQL literal, quoted the way SQLite reads it back. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NULL'
    // SQLite has no infinity literal; 9e999 is how it prints one back.
    if (!Number.isFinite(value)) return value > 0 ? '9e999' : '-9e999'
    return String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    /*
      Through the offset and length, not the whole backing buffer. A view onto
      part of a larger ArrayBuffer would otherwise dump its neighbours' bytes
      into this column. No column here is a BLOB today — photos live in R2 — so
      this is the branch nothing exercises, which is exactly why it should be
      right rather than nearly right.
    */
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return `X'${hex}'`
  }
  return `'${String(value).replace(/'/g, "''")}'`
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** The database has outgrown what a Worker can hold. See MAX_PLAIN_BYTES. */
export class DumpTooLarge extends Error {}

/**
 * Every table, every row, as SQL that restores into D1 or into plain SQLite.
 *
 * Tables and their rows first, then indexes, triggers and views. The order is
 * load-bearing for triggers specifically: created before the inserts, a trigger
 * fires on every restored row and writes rows the original database never had.
 */
export async function dumpDatabase(db: D1Database): Promise<string> {
  /*
    A session rather than the bare binding. D1 serves reads from replicas by
    default, and a dump stitched together from replicas at different points in
    their catch-up is the one corruption nobody would suspect — it restores
    perfectly and is simply missing things. `first-primary` pins the whole dump
    to the primary, in order.
  */
  const session = db.withSession('first-primary')

  const { results } = await session
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`)
    .all<SchemaObject>()

  const objects = results.filter((o) => !isInternal(o.name))
  const tables = objects.filter((o) => o.type === 'table')
  const rest = objects.filter((o) => o.type !== 'table')

  /*
    Measured as it is built, not at the end.

    The ceiling below is about the Worker's 128 MB, and a check that runs after
    the dump is assembled is a check that runs after the memory has already been
    taken — the isolate is killed with no log line and the nightly backup becomes
    a thing that stopped happening for no stated reason. Counting characters
    rather than UTF-8 bytes undercounts non-ASCII, which is the safe direction:
    it can only make the ceiling arrive early, and `runBackup` measures the real
    byte length afterwards.
  */
  let size = 0
  const out: string[] = []
  const push = (line: string) => {
    size += line.length + 1
    if (size > MAX_PLAIN_BYTES) {
      throw new DumpTooLarge(
        `This database is past the ${(MAX_PLAIN_BYTES / 1024 / 1024).toFixed(0)} MB a Worker ` +
          `can dump in memory. Nothing was written — a truncated backup is worse than a ` +
          `missing one. Take this one from a machine with: npm run backup`,
      )
    }
    out.push(line)
  }

  push('-- Allstar logical backup, taken by the Worker on its schedule.')
  push('-- Restores with: wrangler d1 execute <db> --file <this file>')
  push('PRAGMA defer_foreign_keys=true;')

  for (const table of tables) {
    push(`${table.sql.trim().replace(/;\s*$/, '')};`)
  }

  for (const table of tables) {
    const ident = quoteIdent(table.name)
    /*
      Keyset paging on rowid, not LIMIT/OFFSET. OFFSET over a table being written
      to skips and repeats rows, and this runs against a live database — a rep in
      another timezone is awake somewhere. No table here is WITHOUT ROWID, which
      is what makes the key available.
    */
    let after = 0
    for (;;) {
      const page = await session
        .prepare(`SELECT rowid AS __dump_rowid, * FROM ${ident} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .bind(after, PAGE)
        .all<Record<string, unknown>>()

      const rows = page.results
      if (!rows.length) break

      const columns = Object.keys(rows[0]!).filter((c) => c !== '__dump_rowid')
      const columnList = columns.map(quoteIdent).join(', ')

      for (const row of rows) {
        after = Number(row.__dump_rowid)
        const values = columns.map((c) => literal(row[c])).join(', ')
        push(`INSERT INTO ${ident} (${columnList}) VALUES (${values});`)
      }

      if (rows.length < PAGE) break
    }
  }

  for (const object of rest) {
    push(`${object.sql.trim().replace(/;\s*$/, '')};`)
  }

  /*
    A trailing newline after the last `;`, because the restore drill checks that
    the file ends on a terminated statement — that is how it tells a complete
    dump from one whose tail was lost.
  */
  return `${out.join('\n')}\n`
}

/* --- the container --------------------------------------------------------- */

const MAGIC = 'ALLSTAR-BACKUP-1'
const CIPHER = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const SALT_BYTES = 16

/*
  The same numbers `scripts/lib/backup-crypto.mjs` uses, and they have to stay
  the same numbers. N=16384 rather than the 32768 you would pick on a server
  because Node's scrypt has a 32 MB default memory ceiling that 128·N·r would
  cross; the reasoning is written out where the Node copy of these lives.

  Every file carries its own parameters in its header and the reader derives with
  those, so a mismatch here does not make a file unreadable — which is exactly
  what makes it dangerous. Weaken these and every nightly backup opens normally,
  is called encrypted by everyone who touches it, and costs an attacker less per
  guess than the ones taken from a laptop. Nothing would say so. `smoke:backup`
  compares the two headers for that reason.
*/
const KDF = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/**
 * The same refusal `backup.mjs` makes, for the same reason.
 *
 * A file encrypted under `test` is a file everybody involved describes as
 * encrypted, and nothing about its name, header or restore says otherwise.
 */
export const MIN_SECRET_CHARS = 20

const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const concat = (parts: Uint8Array[]) => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Encrypt a dump into the container `scripts/lib/backup-crypto.mjs` reads.
 *
 * The header is plaintext on purpose — somebody holding a file from eight months
 * ago has to be able to see what it is and when it was taken without first
 * proving they can open it — and it is fed to GCM as additional authenticated
 * data, so the salt and the KDF parameters cannot be edited into a file that
 * fails to open for a reason nobody can diagnose.
 */
export async function encryptDump(
  sql: string,
  secret: string,
  source: string,
): Promise<Uint8Array> {
  const { scryptSync } = await import('node:crypto')

  const plain = new TextEncoder().encode(sql)
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const derived = new Uint8Array(scryptSync(secret, salt, KEY_BYTES, KDF))

  const header = {
    kdf: 'scrypt',
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    keyBytes: KEY_BYTES,
    cipher: CIPHER,
    salt: toBase64(salt),
    iv: toBase64(iv),
    created: new Date().toISOString(),
    source,
    plainBytes: plain.length,
    plainSha256: await sha256Hex(plain),
  }
  const preamble = new TextEncoder().encode(`${MAGIC}\n${JSON.stringify(header)}\n`)

  const key = await crypto.subtle.importKey('raw', derived as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ])
  /*
    Web Crypto appends the 16-byte tag to the ciphertext, which is exactly the
    trailer the container expects — so `sealed` is the body and the tag already,
    with nothing to reassemble. The preamble goes in as `additionalData`, which
    is the same bytes Node's `setAAD` receives on the reading side.
  */
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: preamble as BufferSource, tagLength: 128 },
      key,
      plain as BufferSource,
    ),
  )

  return concat([preamble, sealed])
}

/* --- the scheduled run ----------------------------------------------------- */

export interface BackupReport {
  key: string
  plainBytes: number
  bytes: number
  tables: number
  ms: number
}

/**
 * Why a run did not happen, in a sentence an operator can act on.
 *
 * Separate from a thrown error because these are configuration, not faults: the
 * Worker is working exactly as deployed, and the deployment is missing a piece.
 * They are the reason `/api/health` reports whether backups are configured at
 * all — a scheduled backup that has never once run looks, from outside,
 * identical to one that runs every night.
 */
export class BackupNotConfigured extends Error {}

/**
 * Take one backup and put it in R2.
 *
 * Refuses rather than degrades, in both directions. No bucket and no key are
 * each a stop, not a fallback: there is no "write it in the clear for now",
 * because a dump holds every customer's addresses, contact names, phone numbers
 * and password hashes, and "for now" is how every one of those files ends up
 * unencrypted forever.
 */
export async function runBackup(env: Env, now = new Date()): Promise<BackupReport> {
  const started = Date.now()

  if (!env.BACKUPS) {
    throw new BackupNotConfigured(
      'No BACKUPS bucket is bound, so there is nowhere to put a backup. Create the ' +
        'R2 bucket and bind it in wrangler.toml.',
    )
  }
  const secret = env.BACKUP_KEY?.trim()
  if (!secret) {
    throw new BackupNotConfigured(
      'No BACKUP_KEY is set, so there is nothing to encrypt with, and this will not ' +
        'write a dump in the clear. Set it with: wrangler secret put BACKUP_KEY — and ' +
        'use the same key the laptop backups were written with, or the two sets of ' +
        'files will need two keys forever.',
    )
  }
  if (secret.length < MIN_SECRET_CHARS) {
    throw new BackupNotConfigured(
      `BACKUP_KEY is ${secret.length} characters. That is short enough to guess, and a ` +
        `file encrypted with it would still be called encrypted by everyone who touched ` +
        `it. Generate a real one: openssl rand -base64 32`,
    )
  }

  const sql = await dumpDatabase(env.DB)
  const plainBytes = new TextEncoder().encode(sql).length

  if (plainBytes < MIN_PLAIN_BYTES) {
    throw new Error(
      `That dump is ${plainBytes} bytes — too small to be this database. Treating the ` +
        `run as FAILED; do not delete an earlier backup on the strength of it.`,
    )
  }
  /*
    A backstop. `dumpDatabase` counts characters as it goes and stops first; this
    catches the gap between that count and the real UTF-8 length, which is the
    one case where a database of mostly non-ASCII text could slip past it.
  */
  if (plainBytes > MAX_PLAIN_BYTES) {
    throw new DumpTooLarge(
      `That dump is ${(plainBytes / 1024 / 1024).toFixed(1)} MB, past what a Worker can ` +
        `hold. Nothing was written — a truncated backup is worse than a missing one. ` +
        `Take this one from a machine with: npm run backup`,
    )
  }

  /*
    Seconds in the name, and UTC, exactly as `backup.mjs` writes it: two backups
    on one day must not overwrite each other, and a day with two backups on it is
    a day something went wrong.
  */
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const key = `allstar-db-${stamp}.sql.enc`

  const file = await encryptDump(sql, secret, 'allstar-db (worker cron)')

  await env.BACKUPS.put(key, file, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { plainBytes: String(plainBytes), takenBy: 'cron' },
  })

  return {
    key,
    plainBytes,
    bytes: file.length,
    tables: (sql.match(/^CREATE TABLE/gim) ?? []).length,
    ms: Date.now() - started,
  }
}

/**
 * What the bucket actually holds, newest first.
 *
 * ## Why presence was never enough
 *
 * `/api/health` reports `backupBucket` and `backupKey` — that both halves of
 * the configuration exist. That is a claim about the deployment, not about the
 * backups, and the two come apart in every way that matters: a cron that stopped
 * firing, a `put` that threw every night at 07:17, a bucket somebody emptied.
 * All three leave the configuration reporting `true` forever. The nightly job
 * logs every outcome including the boring one, which is right, but a log is only
 * seen by somebody already looking — and the reason to look is exactly the thing
 * the log would have told them.
 *
 * So this returns evidence instead of configuration: the newest object, its
 * size, and when it landed. "Four hours ago, 2.1 MB" and "nineteen days ago"
 * are different sentences; `backupKey: true` is the same sentence in both cases.
 *
 * ## Why this is not on /api/health
 *
 * Sizes and timings describe the database. A dump that halves overnight says
 * something happened to the data, and a run of object names is a map of when
 * this deployment was and was not being backed up — neither belongs on an
 * unauthenticated endpoint, whatever else is already there. The route that
 * serves this is super-admin only.
 *
 * ## What it costs
 *
 * One R2 list of at most `LATEST_SCAN` keys. R2 list is billed as a Class A
 * operation and this runs when a person opens a screen, so it is bounded rather
 * than paginated: nobody needs the full history to answer "did last night work",
 * and an unbounded scan of a bucket that has been filling for a year is a
 * surprise nobody asked for.
 */
export interface BackupEvidence {
  configured: boolean
  /** Why not, when `configured` is false. Never a key, a length or a prefix. */
  reason?: string
  latest?: { key: string; bytes: number; uploadedAt: number }
  /** How many objects the bounded scan saw. `LATEST_SCAN` means "at least". */
  seen: number
  scanCapped: boolean
}

/**
 * Who may see evidence of backups.
 *
 * Super admin alone. Not because a key, a size and a timestamp are dramatic in
 * themselves, but because the size describes the database and the run of names
 * describes when this deployment was and was not being backed up — and the
 * database is every customer's, not one company's. A client admin has no
 * company-scoped view of this to be given.
 */
export const canSeeBackups = (user: { role: string }) => user.role === 'super_admin'

/** Enough to see a pattern, few enough that the list stays one cheap call. */
const LATEST_SCAN = 60

export async function latestBackup(env: Env): Promise<BackupEvidence> {
  if (!env.BACKUPS) {
    return { configured: false, reason: 'No BACKUPS bucket is bound.', seen: 0, scanCapped: false }
  }
  if (!env.BACKUP_KEY?.trim()) {
    return {
      configured: false,
      reason: 'No BACKUP_KEY is set, so the nightly job refuses to write a dump in the clear.',
      seen: 0,
      scanCapped: false,
    }
  }

  const listed = await env.BACKUPS.list({ limit: LATEST_SCAN })
  /*
    R2 lists lexicographically, and the key is `allstar-db-<ISO stamp>.sql.enc`
    with the stamp's colons and dots swapped for dashes. An ISO stamp sorts the
    same lexicographically as it does chronologically, so the last key is the
    newest — but that is a property of the naming scheme rather than of R2, and
    a hand-uploaded file with a different name would break it silently. Sorting
    on `uploaded`, which R2 records itself, cannot be broken by a filename.
  */
  const newest = listed.objects.reduce<R2Object | null>(
    (best, o) => (!best || o.uploaded > best.uploaded ? o : best),
    null,
  )

  return {
    configured: true,
    latest: newest
      ? { key: newest.key, bytes: newest.size, uploadedAt: newest.uploaded.getTime() }
      : undefined,
    seen: listed.objects.length,
    scanCapped: listed.truncated || listed.objects.length >= LATEST_SCAN,
  }
}
