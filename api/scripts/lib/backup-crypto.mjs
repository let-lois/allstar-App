import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { appendFileSync, createReadStream, createWriteStream, openSync, readFileSync, readSync, closeSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/**
 * Encrypting the database dump at rest.
 *
 * A backup of this database is the single most sensitive artifact the project
 * can produce: every customer's addresses, contact names and phone numbers,
 * plus password hashes, in one file that is designed to be copied somewhere
 * else. `backups/` being git-ignored keeps it off GitHub and does nothing at
 * all about the copy on a laptop, in a Downloads folder, or in whatever cloud
 * drive that laptop syncs to. Encryption is the only control that survives the
 * file leaving the machine it was made on, which is the file's whole purpose.
 *
 * The same reasoning as `api/src/secretbox.ts`, one layer out: two things an
 * attacker needs, kept in two places that fail independently. There the pair is
 * a Worker secret and a D1 row; here it is a key on the operator's machine and
 * a dump file. Different code because this runs in Node against a file on disk,
 * not in a Worker against a string in a column — streams and a key derivation
 * that can afford to be slow.
 *
 * ## The container
 *
 *     ALLSTAR-BACKUP-1\n            magic, so a wrong file is refused by name
 *     {"kdf":"scrypt",...}\n        header, plaintext and authenticated
 *     <ciphertext…>                 AES-256-GCM
 *     <16-byte auth tag>            trailer
 *
 * The header is readable without the key on purpose. Someone holding a file
 * from eight months ago needs to be able to see what it is, when it was taken
 * and which database it came from without first proving they can open it —
 * otherwise a lost key turns a directory of backups into a directory of
 * indistinguishable noise. It carries no secret: parameters, a salt, an IV, a
 * timestamp, a size, and a hash of the plaintext.
 *
 * It is fed to GCM as additional authenticated data, so it cannot be edited
 * either. Without that, the KDF parameters and the salt sit outside the
 * authentication and an attacker can rewrite them — not to forge plaintext,
 * which GCM still prevents, but to turn every restore into an unexplained
 * failure. A backup that fails to open for a reason nobody can diagnose is a
 * backup that gets deleted.
 *
 * ## scrypt, and why not SHA-256 like secretbox
 *
 * `secretbox.ts` derives its AES key with a single SHA-256 because it runs on
 * every outbound CRM call and the input is a machine-generated secret. Neither
 * holds here. This runs twice in the life of a backup, so slow costs nothing,
 * and the secret is one a human generated and may well have shortened,
 * re-used, or typed from memory. scrypt with a per-file salt means a weak
 * passphrase costs an attacker real time and memory per guess, and two backups
 * taken with the same key share no derived key.
 *
 * ## AES-GCM, and what the tag is actually for
 *
 * The obvious job is tamper detection. The one that matters more often is
 * truncation. `wrangler d1 export` into a full disk, an interrupted copy, a
 * sync client that uploaded half a file — all produce a dump that restores
 * without error up to the cut, and the existing drill catches that only by
 * counting rows. A GCM tag over the whole stream turns every one of those into
 * a refusal at the door, before anything is restored anywhere.
 *
 * ## Losing the key
 *
 * There is no recovery. This is not `INTEGRATION_KEY`, where a rotation costs
 * every customer a reconnect; and it is not `SESSION_PEPPER`, where a rotation
 * signs everyone out. Lose this and every backup encrypted with it is
 * permanently unreadable — the disaster the backups existed to prevent, arrived
 * by a different road. The key belongs somewhere that is neither this repo nor
 * the same laptop as the backups, and old keys are kept forever rather than
 * replaced, because a file from before a rotation still wants the key it was
 * written with.
 */

const MAGIC = 'ALLSTAR-BACKUP-1'
const CIPHER = 'aes-256-gcm'
const TAG_BYTES = 16
const IV_BYTES = 12
const SALT_BYTES = 16
const KEY_BYTES = 32

/*
  N=16384 rather than the 32768 you would pick on a server. Node's scrypt has a
  32 MB default memory ceiling and 128·N·r puts 32768 over it, so that value
  fails at runtime unless every call site remembers to raise maxmem. It is
  written explicitly below anyway, but the parameters also travel inside every
  file that has ever been written, so a value that works everywhere without a
  flag is worth more here than a marginally higher cost per guess.
*/
const KDF = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** Where the key lives when it is not in the environment. Git-ignored. */
export const KEY_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.backup-key')

/**
 * A secret shorter than this is refused rather than accepted quietly.
 *
 * The failure this prevents is not a brute-force attack, it is a false sense of
 * one being impossible. A file encrypted under "test" is a file everybody
 * involved will describe as encrypted, and it is not — but nothing about the
 * filename, the header or the restore drill would ever say so. Twenty
 * characters is below what the documented command produces (44) and above
 * anything anyone types as a placeholder.
 */
export const MIN_SECRET_CHARS = 20

export class NoBackupKey extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoBackupKey'
  }
}

/**
 * The secret, from the environment or the key file — never from an argument.
 *
 * Deliberately not a command-line flag. A secret passed as an argument is a
 * secret in the shell history, in `ps` output for the length of the run, and in
 * any CI log that echoes its own commands.
 *
 * Returns null when there is no key at all, which callers turn into a refusal.
 * Throws when there is a key and it is unusable, because that is a different
 * situation and deserves a different sentence.
 */
export function loadBackupKey() {
  const fromEnv = process.env.BACKUP_KEY?.trim()
  if (fromEnv) return check(fromEnv, 'the BACKUP_KEY environment variable')

  let fromFile = null
  try {
    fromFile = readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return null
  }
  if (!fromFile) return null
  return check(fromFile, KEY_FILE)
}

function check(secret, where) {
  if (secret.length < MIN_SECRET_CHARS) {
    throw new NoBackupKey(
      `The backup key in ${where} is ${secret.length} characters. That is short enough\n` +
        `to guess, and a file encrypted with it would still be described as encrypted by\n` +
        `everyone who touched it. Generate a real one:\n\n` +
        `  openssl rand -base64 32\n`,
    )
  }
  return { secret, where }
}

/** The instruction, in one place, because three commands need to print it. */
export function keySetupHelp() {
  return (
    `No backup key is configured, so there is nothing to encrypt with.\n\n` +
    `Generate one, once, and keep it somewhere that is not this repo and not the\n` +
    `same machine as the backups:\n\n` +
    `  openssl rand -base64 32\n\n` +
    `Then either export it as BACKUP_KEY, or save it to:\n\n` +
    `  ${KEY_FILE}\n\n` +
    `That path is git-ignored. Keep the key forever — if it is lost, every backup\n` +
    `written with it is unreadable, and no part of this project can recover them.`
  )
}

/**
 * The key, from a secret and a salt.
 *
 * `params` comes from the file's own header when reading, and from the constants
 * above when writing. That distinction is the point: the header records N, r, p
 * and the key length in every file ever written, and for a while nothing read
 * them back — decryption used today's constants regardless, so a file written
 * with any other parameters was unreadable *while carrying the numbers needed to
 * read it*. Nothing had done that yet, and the gates would have caught the first
 * one; but a format that documents parameters it then ignores is a trap set for
 * whoever changes them, and there are two writers now rather than one.
 *
 * They are safe to trust. The header is fed to GCM as additional authenticated
 * data, so an attacker cannot edit the parameters without the file failing to
 * authenticate — which is why it was worth authenticating them in the first
 * place.
 */
const derive = (secret, salt, params = KDF) =>
  scryptSync(secret, salt, params.keyBytes ?? KEY_BYTES, {
    N: params.N ?? KDF.N,
    r: params.r ?? KDF.r,
    p: params.p ?? KDF.p,
    maxmem: KDF.maxmem,
  })

/** SHA-256 of a file, streamed. */
async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Encrypt `plainPath` to `outPath`.
 *
 * The plaintext is read twice — once to hash it, once to encrypt it. That is a
 * deliberate trade: the hash has to be inside the authenticated header, and the
 * header has to be written before the ciphertext it authenticates. Buffering the
 * whole dump in memory to get one pass would put a ceiling on how large a
 * database this tool works for, which is the wrong thing to optimise.
 */
export async function encryptFile({ plainPath, outPath, secret, source, kdf }) {
  const plainBytes = statSync(plainPath).size
  const plainSha256 = await sha256File(plainPath)

  /*
    `kdf` overrides the parameters for one file. Nothing in the project passes
    it — production backups use the constants — and it exists so the gate can
    prove that what the header records is what the reader uses. A format whose
    recorded parameters are never exercised is a format whose recorded
    parameters are decorative.
  */
  const params = { N: KDF.N, r: KDF.r, p: KDF.p, keyBytes: KEY_BYTES, ...kdf }

  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = derive(secret, salt, params)

  const header = {
    kdf: 'scrypt',
    N: params.N,
    r: params.r,
    p: params.p,
    keyBytes: params.keyBytes,
    cipher: CIPHER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    created: new Date().toISOString(),
    source: source ?? null,
    plainBytes,
    plainSha256,
  }
  const preamble = Buffer.from(`${MAGIC}\n${JSON.stringify(header)}\n`, 'utf8')

  const cipher = createCipheriv(CIPHER, key, iv)
  cipher.setAAD(preamble)

  /*
    Written to a temporary name and renamed at the end. A half-written .enc left
    behind by an interrupted run is a file that looks like a backup in a
    directory listing, and the moment somebody deletes an older one on the
    strength of it, the interruption has cost them the backup.
  */
  const temp = `${outPath}.partial`
  try {
    const out = createWriteStream(temp)
    out.write(preamble)
    await pipeline(createReadStream(plainPath), cipher, out)
    // The tag exists only after `final()`, which the pipeline above ran, so it
    // can only be a trailer — appended rather than streamed because it is
    // sixteen bytes and the stream it belongs to has already closed.
    appendFileSync(temp, cipher.getAuthTag())
    renameSync(temp, outPath)
  } catch (err) {
    try { unlinkSync(temp) } catch {}
    throw err
  }

  return { header, bytes: statSync(outPath).size }
}

/** True if the file starts with our magic — cheap, and needs no key. */
export function isEncryptedBackup(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(MAGIC.length)
    readSync(fd, buf, 0, MAGIC.length, 0)
    return buf.toString('utf8') === MAGIC
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The header, without decrypting anything and without needing the key.
 *
 * This is what makes a directory of .enc files legible: what it is, when it was
 * taken, how big the database was. Also returns `preamble`, the exact bytes that
 * were fed to GCM as AAD — reconstructing them by re-serialising the JSON would
 * be a byte-for-byte gamble on key order and spacing.
 */
export function readBackupHeader(path) {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const probe = Buffer.alloc(Math.min(64 * 1024, size))
    readSync(fd, probe, 0, probe.length, 0)

    const firstNl = probe.indexOf(0x0a)
    if (firstNl < 0 || probe.subarray(0, firstNl).toString('utf8') !== MAGIC) {
      throw new Error(`Not an Allstar encrypted backup (no ${MAGIC} marker).`)
    }
    const secondNl = probe.indexOf(0x0a, firstNl + 1)
    if (secondNl < 0) throw new Error('Truncated: the header does not end.')

    const json = probe.subarray(firstNl + 1, secondNl).toString('utf8')
    let header
    try {
      header = JSON.parse(json)
    } catch {
      throw new Error('The header is not readable JSON — the file is damaged.')
    }
    const preambleLength = secondNl + 1
    return { header, preamble: probe.subarray(0, preambleLength), preambleLength, size }
  } finally {
    closeSync(fd)
  }
}

/**
 * Decrypt `path` to `outPath`, or refuse.
 *
 * Refusal is the important half. Every way this can go wrong — wrong key, a
 * flipped byte, a truncated upload, an edited header — has to end with no
 * plaintext on disk, because a partial dump that restores cleanly up to the cut
 * is the exact failure the encryption was worth adding for. So the output is
 * built under a temporary name and only renamed after the tag verifies and the
 * plaintext hash matches what the header promised.
 */
export async function decryptFile({ path, outPath, secret }) {
  const { header, preamble, preambleLength, size } = readBackupHeader(path)

  if (header.cipher !== CIPHER || header.kdf !== 'scrypt') {
    throw new Error(`Unsupported backup format (${header.kdf}/${header.cipher}).`)
  }
  const bodyBytes = size - preambleLength - TAG_BYTES
  if (bodyBytes < 0) throw new Error('Truncated: the file is shorter than its own header and tag.')

  const fd = openSync(path, 'r')
  let tag
  try {
    tag = Buffer.alloc(TAG_BYTES)
    readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES)
  } finally {
    closeSync(fd)
  }

  const key = derive(secret, Buffer.from(header.salt, 'base64'), header)
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(preamble)
  decipher.setAuthTag(tag)

  const temp = `${outPath}.partial`
  const hash = createHash('sha256')
  try {
    await pipeline(
      // `end` is inclusive, so this stops on the last ciphertext byte and never
      // feeds the tag itself back in as data.
      createReadStream(path, { start: preambleLength, end: size - TAG_BYTES - 1 }),
      decipher,
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk)
          yield chunk
        }
      },
      createWriteStream(temp),
    )
  } catch (err) {
    try { unlinkSync(temp) } catch {}
    /*
      GCM reports every one of these the same way, and the message it uses
      ("Unsupported state or unable to authenticate data") sends people looking
      for a bug in the tool. The three real causes are worth naming, because the
      response to each is different: find the right key, re-download the file,
      or go back to the source database.
    */
    if (/unable to authenticate|Unsupported state/i.test(String(err?.message))) {
      throw new Error(
        `This backup did not authenticate. That is one of three things, and the file\n` +
          `itself cannot tell you which:\n\n` +
          `  the key is not the one it was written with\n` +
          `  the file was damaged or truncated in transit\n` +
          `  the file was deliberately altered\n\n` +
          `Nothing was written. Do not restore from this file.`,
      )
    }
    throw err
  }

  /*
    The tag already proves the bytes are the bytes. This proves they are the same
    bytes the dump had when it was made — it catches a plaintext that was already
    wrong before encryption, and it is the only check that spans the whole
    pipeline rather than one hop of it.
  */
  const got = hash.digest('hex')
  if (header.plainSha256 && got !== header.plainSha256) {
    try { unlinkSync(temp) } catch {}
    throw new Error(
      `The backup authenticated but its contents do not match the fingerprint recorded\n` +
        `when it was taken. Nothing was written.`,
    )
  }
  const actual = statSync(temp).size
  if (header.plainBytes != null && actual !== header.plainBytes) {
    try { unlinkSync(temp) } catch {}
    throw new Error(
      `The backup decrypted to ${actual} bytes, not the ${header.plainBytes} it recorded.`,
    )
  }

  renameSync(temp, outPath)
  return { header, bytes: statSync(outPath).size }
}
