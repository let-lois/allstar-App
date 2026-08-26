import type { Env } from './types'

/**
 * Encrypting third-party credentials at rest.
 *
 * A customer's GoHighLevel token is write access to their CRM. It sits in D1
 * next to their addresses and their contacts, and we now take a nightly dump of
 * that database — so a leaked backup would hand over every customer's CRM along
 * with everything else. Hashing is not an option the way it is for passwords:
 * the token has to be replayed on every call, so it has to come back.
 *
 * So it is encrypted, and the key lives as a Worker secret rather than in D1. A
 * stolen database — or a stolen backup file — is then useless on its own, which
 * is the whole point: the two things an attacker needs are kept in two places
 * that fail independently.
 *
 * AES-GCM, because it authenticates as well as encrypts. A token that has been
 * tampered with fails to decrypt rather than decrypting into garbage that gets
 * sent to a customer's CRM.
 *
 * **On rotating INTEGRATION_KEY.** Unlike `SESSION_PEPPER`, this one is
 * survivable: changing it makes every stored token undecryptable, and the
 * recovery is that each customer reconnects their account. Unpleasant and
 * visible, not catastrophic. The stored format is versioned (`v1:iv:ct`) so a
 * future rotation can decrypt old values with the old key while writing new
 * ones with the new key, rather than forcing everyone through a reconnect.
 */

const VERSION = 'v1'
const IV_BYTES = 12

/** Thrown when the deployment has no key — never with the key in the message. */
export class NoIntegrationKey extends Error {
  constructor() {
    super('INTEGRATION_KEY is not set on this deployment.')
    this.name = 'NoIntegrationKey'
  }
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/**
 * The AES key, derived from the secret rather than used raw.
 *
 * The secret is a string a human generated, of unknown length and unknown
 * entropy distribution; AES-GCM wants exactly 256 bits. SHA-256 over the secret
 * gives that deterministically. This is not password hashing and does not need
 * to be slow — the input is a high-entropy secret, not something guessable, and
 * this runs on every send.
 */
async function keyFor(env: Env): Promise<CryptoKey> {
  const secret = env.INTEGRATION_KEY
  if (!secret) throw new NoIntegrationKey()
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** `v1:<iv>:<ciphertext>`, both base64. */
export async function seal(env: Env, plaintext: string): Promise<string> {
  const key = await keyFor(env)
  // A fresh IV per value. Reusing one under the same key breaks GCM outright,
  // so this is generated here rather than being anything a caller can pass in.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return `${VERSION}:${b64(iv)}:${b64(new Uint8Array(ct))}`
}

/**
 * Returns null rather than throwing on anything malformed.
 *
 * A credential that cannot be decrypted is a connection that no longer works,
 * which is a state the caller has to handle anyway — the key was rotated, the
 * row was written by a different deployment, the value was tampered with. Making
 * that an exception would turn a broken integration for one customer into a 500
 * for whatever request happened to touch it.
 */
export async function open(env: Env, sealed: string): Promise<string | null> {
  const parts = sealed.split(':')
  if (parts.length !== 3 || parts[0] !== VERSION) return null
  try {
    const key = await keyFor(env)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(parts[1]) },
      key,
      unb64(parts[2]),
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/**
 * The last four characters, for showing an admin which token is connected.
 *
 * Deliberately not a prefix: GHL tokens carry a recognisable prefix that says
 * nothing about *which* token this is, so showing it would be a hint to an
 * attacker and useless to the person who needs to tell two tokens apart.
 */
export function tokenHint(token: string): string {
  return token.length <= 4 ? '••••' : `••••${token.slice(-4)}`
}
