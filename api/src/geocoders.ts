import type { Env } from './types'
import { NoIntegrationKey, open, seal, tokenHint } from './secretbox'
import { findProvider, GEOCODE_PROVIDERS, isSelectable } from './geocode-providers'

/**
 * A company's own geocoding provider.
 *
 * The reason this exists is not cost. It is that the vendors disagree about
 * whether we may keep what they return, and a company that already pays one of
 * them should be able to geocode under their own contract rather than ours —
 * which is also the only version of this where the company, not us, is the one
 * accepting the vendor's terms.
 *
 * Everything here follows the rules the CRM credentials already established,
 * because they were learned the expensive way and none of them are specific to
 * CRMs:
 *
 *   - the key is encrypted at rest and never leaves the Worker
 *   - no endpoint returns it, in a response or an error, ever
 *   - the masked hint is derived by decrypting and re-masking, never stored,
 *     so a database dump does not carry a readable fragment of the thing the
 *     encryption exists to protect
 *   - with no INTEGRATION_KEY on the deployment we refuse to store anything and
 *     say so, rather than writing a customer's key in plaintext
 */

export interface GeocoderRow {
  provider: string
  active: boolean
  /** Masked, e.g. "abcd…wxyz". Derived on read; never stored. */
  hint: string
  status: string
  lastOkAt?: number
  lastError?: string
  lastErrorAt?: number
}

/**
 * What the admin screen is allowed to know.
 *
 * The catalogue travels with the saved rows rather than being duplicated in the
 * client: the terms a company is agreeing to when they pick a provider are the
 * whole point of the screen, and two copies of them would eventually disagree.
 */
export async function listGeocoders(env: Env, clientId: string) {
  const { results } = await env.DB.prepare(
    `SELECT provider, active, api_key, status, last_ok_at, last_error, last_error_at
       FROM client_geocoders WHERE client_id = ?1`,
  )
    .bind(clientId)
    .all<{
      provider: string
      active: number
      api_key: string
      status: string
      last_ok_at: number | null
      last_error: string | null
      last_error_at: number | null
    }>()

  const configured: GeocoderRow[] = []
  for (const r of results ?? []) {
    // A key that will not decrypt is configured in name only. Saying so beats
    // showing it as healthy and geocoding nothing — the same call the CRM panel
    // makes about a token it cannot read.
    const plain = await open(env, r.api_key).catch(() => null)
    configured.push({
      provider: r.provider,
      active: r.active === 1,
      hint: plain ? tokenHint(plain) : '(unreadable — re-enter the key)',
      status: plain ? r.status : 'unreadable',
      lastOkAt: r.last_ok_at ?? undefined,
      lastError: r.last_error ?? undefined,
      lastErrorAt: r.last_error_at ?? undefined,
    })
  }

  return {
    /** The catalogue, so the screen can state the terms it is asking about. */
    providers: GEOCODE_PROVIDERS,
    configured,
    /** Census when nothing is chosen — the free default, not an error state. */
    active: configured.find((c) => c.active)?.provider ?? 'census',
  }
}

export class UnknownProvider extends Error {
  constructor(id: string) {
    super(`${id} is not a geocoding provider this app knows about.`)
    this.name = 'UnknownProvider'
  }
}

export class ProviderNotReady extends Error {
  constructor(label: string) {
    super(
      `${label} is not connected yet — this deployment has no adapter for it, so a key would never be used. Nothing was saved.`,
    )
    this.name = 'ProviderNotReady'
  }
}

/**
 * Store a company's key for one provider.
 *
 * Refuses a provider with no adapter rather than banking a key that would never
 * be called. The failure that avoids is specific and bad: an operator pastes a
 * key, the screen says saved, and the next import silently geocodes with Census
 * anyway — a wrong answer that looks exactly like a right one, which is the
 * failure mode this codebase spends the most effort refusing.
 */
export async function saveGeocoderKey(
  env: Env,
  clientId: string,
  providerId: string,
  apiKey: string,
): Promise<void> {
  const provider = findProvider(providerId)
  if (!provider) throw new UnknownProvider(providerId)
  if (!provider.needsKey) throw new UnknownProvider(providerId)
  if (!isSelectable(providerId)) throw new ProviderNotReady(provider.label)
  if (!env.INTEGRATION_KEY) throw new NoIntegrationKey()

  const sealed = await seal(env, apiKey)
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO client_geocoders
       (client_id, provider, api_key, active, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 0, 'active', ?4, ?4)
     ON CONFLICT(client_id, provider) DO UPDATE SET
       api_key = ?3, status = 'active', last_error = NULL,
       last_error_at = NULL, updated_at = ?4`,
  )
    .bind(clientId, providerId, sealed, now)
    .run()
}

/**
 * Choose which provider actually runs.
 *
 * Census is always allowed and never needs a key. Anything else must already
 * have one stored — selecting a provider whose key is missing would leave the
 * company geocoding with nothing, so it is refused here rather than discovered
 * at import time.
 */
export async function setActiveGeocoder(
  env: Env,
  clientId: string,
  providerId: string,
): Promise<void> {
  const provider = findProvider(providerId)
  if (!provider) throw new UnknownProvider(providerId)
  if (!isSelectable(providerId)) throw new ProviderNotReady(provider.label)

  if (provider.needsKey) {
    const row = await env.DB.prepare(
      `SELECT 1 AS ok FROM client_geocoders WHERE client_id = ?1 AND provider = ?2`,
    )
      .bind(clientId, providerId)
      .first<{ ok: number }>()
    if (!row) throw new ProviderNotReady(provider.label)
  }

  // Clearing first and setting second, because the partial unique index permits
  // exactly one active row per client and would reject the pair in the other
  // order. D1 has no multi-statement transaction here; the window between the
  // two writes leaves a company on Census for a moment, which is the harmless
  // direction for it to fail.
  await env.DB.prepare(`UPDATE client_geocoders SET active = 0 WHERE client_id = ?1`)
    .bind(clientId)
    .run()

  if (provider.needsKey) {
    await env.DB.prepare(
      `UPDATE client_geocoders SET active = 1, updated_at = ?3
        WHERE client_id = ?1 AND provider = ?2`,
    )
      .bind(clientId, providerId, Date.now())
      .run()
  }
}

/** Forget a company's key. Census takes over, because it always can. */
export async function removeGeocoder(
  env: Env,
  clientId: string,
  providerId: string,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM client_geocoders WHERE client_id = ?1 AND provider = ?2`,
  )
    .bind(clientId, providerId)
    .run()
}

/**
 * The provider and decrypted key to geocode this company's addresses with.
 *
 * Not exported through any route — the key is read here, used inside the
 * Worker, and never travels. Returns null for Census and for every failure,
 * because every one of them means the same thing to the caller: fall back to
 * the chain that needs no key.
 */
export async function activeGeocoderFor(
  env: Env,
  clientId: string,
): Promise<{ provider: string; key: string } | null> {
  const row = await env.DB.prepare(
    `SELECT provider, api_key FROM client_geocoders
      WHERE client_id = ?1 AND active = 1 AND status = 'active'`,
  )
    .bind(clientId)
    .first<{ provider: string; api_key: string }>()
  if (!row) return null

  const key = await open(env, row.api_key).catch(() => null)
  if (!key) return null
  return { provider: row.provider, key }
}
