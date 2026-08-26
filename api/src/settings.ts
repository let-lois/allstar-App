import { record } from './audit'
import { isValidZone } from './day'
import { canInvite } from './invites'
import type { Env, SessionUser } from './types'

/**
 * Per-company configuration of the field app.
 *
 * The rule that shapes all of this: **codes are structural, labels are not.**
 * `sold`, `no_answer` and the rest are keys that reporting, pipeline stages and a
 * year of history all depend on. A company renaming "Quote requested" to
 * "Estimate requested" is changing a word on a button, and it must not change
 * what any of that history means.
 *
 * So this stores presentation only — label and order — against codes that stay in
 * the source. There is no way through this API to invent an outcome, remove one,
 * or change what a code means, because each of those would silently rewrite the
 * past.
 */

export interface ClientSettings {
  /** Label and position overrides, keyed by the immutable outcome code. */
  outcomes?: { code: string; label?: string; order?: number }[]
  noteTemplates?: string[]
  photoCategories?: { key: string; label?: string }[]
}

const MAX_TEMPLATES = 24
const MAX_LABEL = 40
const MAX_TEMPLATE = 80

/**
 * Trusts nothing from the client. Anything unrecognised is dropped rather than
 * stored — a settings blob is read by every phone on every boot, and one bad
 * value would break the outcome grid for the whole company at once.
 */
export function sanitise(input: unknown, validCodes: string[], validCategories: string[]): ClientSettings {
  const raw = (input ?? {}) as Record<string, unknown>
  const out: ClientSettings = {}

  if (Array.isArray(raw.outcomes)) {
    const seen = new Set<string>()
    out.outcomes = raw.outcomes
      .map((o) => (o ?? {}) as Record<string, unknown>)
      .filter((o) => typeof o.code === 'string' && validCodes.includes(o.code))
      .filter((o) => {
        const code = String(o.code)
        if (seen.has(code)) return false
        seen.add(code)
        return true
      })
      .map((o, i) => ({
        code: String(o.code),
        label:
          typeof o.label === 'string' && o.label.trim()
            ? o.label.trim().slice(0, MAX_LABEL)
            : undefined,
        order: typeof o.order === 'number' && Number.isFinite(o.order) ? o.order : i,
      }))
  }

  if (Array.isArray(raw.noteTemplates)) {
    out.noteTemplates = raw.noteTemplates
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim().slice(0, MAX_TEMPLATE))
      .slice(0, MAX_TEMPLATES)
  }

  if (Array.isArray(raw.photoCategories)) {
    const seen = new Set<string>()
    out.photoCategories = raw.photoCategories
      .map((c) => (c ?? {}) as Record<string, unknown>)
      .filter((c) => typeof c.key === 'string' && validCategories.includes(c.key))
      .filter((c) => {
        const key = String(c.key)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((c) => ({
        key: String(c.key),
        label:
          typeof c.label === 'string' && c.label.trim()
            ? c.label.trim().slice(0, MAX_LABEL)
            : undefined,
      }))
  }

  return out
}

export async function readSettings(env: Env, clientId: string): Promise<ClientSettings> {
  const row = await env.DB.prepare('SELECT settings FROM client_settings WHERE client_id = ?1')
    .bind(clientId)
    .first<{ settings: string }>()
  if (!row) return {}
  try {
    return JSON.parse(row.settings) as ClientSettings
  } catch {
    // A corrupt blob must not take the field app down; defaults are always safe.
    console.error('client settings unparseable', clientId)
    return {}
  }
}

export async function writeSettings(
  env: Env,
  actor: SessionUser,
  input: unknown,
  valid: { codes: string[]; categories: string[] },
): Promise<{ ok: true; settings: ClientSettings } | { error: string; status: number }> {
  if (!canInvite(actor)) return { error: 'Not permitted.', status: 403 }

  const settings = sanitise(input, valid.codes, valid.categories)

  await env.DB.prepare(
    `INSERT INTO client_settings (client_id, settings, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(client_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
  )
    .bind(actor.clientId, JSON.stringify(settings), Date.now())
    .run()

  await record(env, actor, {
    action: 'settings.changed',
    targetType: 'settings',
    targetLabel: 'Field app settings',
    detail: {
      outcomes: settings.outcomes?.length ?? 0,
      noteTemplates: settings.noteTemplates?.length ?? 0,
      photoCategories: settings.photoCategories?.length ?? 0,
    },
  })

  return { ok: true, settings }
}

/* --- the company's calendar ------------------------------------------------ */

/**
 * Set the timezone reporting days are cut on.
 *
 * Its own endpoint rather than a field in the settings blob, and deliberately.
 * That blob is presentation only — labels and order, by its own rule, so that a
 * rename can never rewrite what a year of history means. This is the opposite
 * kind of value: changing it changes which day past work belongs to. Putting it
 * in the same bag as a button label would be filing a structural fact under
 * cosmetics.
 *
 * Changing it does NOT re-bucket existing rows. Those were written on the old
 * calendar and stay there until history is rebuilt from `visits`, which is a
 * deliberate, separate, backed-up operation — see scripts/rebuild-daily-stats.mjs.
 * Silently rewriting a year of reporting because somebody opened a dropdown is
 * not a thing this should be able to do.
 */
export async function writeTimezone(
  env: Env,
  actor: SessionUser,
  tz: unknown,
): Promise<{ ok: true; timezone: string } | { error: string; status: number }> {
  if (!canInvite(actor)) return { error: 'Not permitted.', status: 403 }

  const value = typeof tz === 'string' ? tz.trim() : ''
  if (!isValidZone(value)) {
    return {
      error: `"${value.slice(0, 60)}" is not a timezone this server recognises.`,
      status: 400,
    }
  }

  const before = actor.timezone
  await env.DB.prepare('UPDATE clients SET timezone = ?2 WHERE id = ?1')
    .bind(actor.clientId, value)
    .run()

  await record(env, actor, {
    action: 'settings.timezone',
    targetType: 'settings',
    targetLabel: 'Reporting timezone',
    // Both sides, because "when did the numbers move and by how much" is the
    // question somebody asks three months later.
    detail: { from: before, to: value },
  })

  return { ok: true, timezone: value }
}
