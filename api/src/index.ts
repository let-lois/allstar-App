import {
  PBKDF2_ITERATIONS,
  bearerToken,
  hashPassword,
  login,
  resolveSession,
  revokeSession,
} from './auth'
import {
  acceptInvite,
  canInvite,
  createInvite,
  readInvite,
  runSetup,
} from './invites'
import { GEOCODE_CHUNK, geocode, type GeocodeRequest } from './geocode'
import { MAX_IMPORT_ROWS, canImport, importProperties, type ImportInput } from './import'
import { assignTerritory } from './assign'
import { applyMutations } from './mutations'
import { invitePage, setupPage } from './pages'
import { bootstrap } from './read'
import type { Env, Mutation, Role, SessionUser } from './types'

/**
 * Allstar API.
 *
 * Small on purpose. The client is offline-first and owns its own state, so this
 * is not a chatty REST surface — it's three things:
 *
 *   POST /api/auth/login   who you are
 *   GET  /api/bootstrap    everything you cache
 *   POST /api/mutations    everything you did, replayed exactly once
 *
 * Plus a photo upload, which is separate because a multi-megabyte body has no
 * business inside a batched write that has to succeed atomically on bad signal.
 */

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim())
  // Echo only an origin we know. A wildcard would let any site on the internet
  // drive this API with a rep's credentials.
  if (!origin || !allowed.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

async function requireUser(req: Request, env: Env): Promise<SessionUser | null> {
  const token = bearerToken(req)
  if (!token) return null
  return resolveSession(env, token)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env)

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      /* --- account bootstrap (HTML, served by the Worker itself) ---------- */
      //
      // These are pages rather than API routes because they're used *before*
      // anyone can sign in: the first admin has no account, and an invited rep
      // has no password. The React app can't help with either.
      const appUrl = env.APP_URL ?? 'https://allstar.letlois.com'

      if (path === '/setup') {
        if (req.method === 'GET') {
          const existing = await env.DB.prepare('SELECT 1 AS ok FROM users LIMIT 1').first()
          if (existing) return setupPage({ appUrl, done: true })
          return setupPage({ appUrl })
        }
        if (req.method === 'POST') {
          // Setup runs once, by an operator, before anything exists. A generic
          // "something went wrong" here is useless to the one person who needs
          // to act on it — so the real reason is shown on the page.
          try {
            const form = await req.formData()
            const result = await runSetup(env, {
              token: String(form.get('token') ?? ''),
              clientName: String(form.get('clientName') ?? ''),
              name: String(form.get('name') ?? ''),
              email: String(form.get('email') ?? ''),
              password: String(form.get('password') ?? ''),
            })
            return result.ok
              ? setupPage({ appUrl, done: true })
              : setupPage({ appUrl, error: result.error })
          } catch (err) {
            console.error('setup failed', err)
            return setupPage({
              appUrl,
              error: `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        }
      }

      if (path.startsWith('/invite/')) {
        const token = path.slice('/invite/'.length)
        if (req.method === 'GET') {
          const invite = await readInvite(env, token)
          return invitePage({ token, invite: invite ?? undefined, appUrl })
        }
        if (req.method === 'POST') {
          const form = await req.formData()
          const result = await acceptInvite(env, token, String(form.get('password') ?? ''))
          if (result.ok) return invitePage({ token, appUrl, done: true })
          const invite = await readInvite(env, token)
          return invitePage({ token, invite: invite ?? undefined, error: result.error, appUrl })
        }
      }

      /* --- self test ------------------------------------------------------ */
      //
      // Password hashing is deliberately expensive, and a Worker has a hard CPU
      // budget per request — so "can this deployment hash a password at all?"
      // is a real question with a real answer, not something to infer from a
      // 500. Reports the cost so a too-small budget is diagnosable directly.
      if (path === '/api/selftest') {
        const started = Date.now()
        try {
          await hashPassword('self-test-password', 'self-test-salt', env.SESSION_PEPPER ?? '')
          return json({ ok: true, hashMs: Date.now() - started, iterations: PBKDF2_ITERATIONS }, 200, cors)
        } catch (err) {
          return json(
            {
              ok: false,
              hashMs: Date.now() - started,
              iterations: PBKDF2_ITERATIONS,
              error: err instanceof Error ? err.message : String(err),
            },
            500,
            cors,
          )
        }
      }

      /* --- geocoder probe -------------------------------------------------- */
      //
      // The geocoder is a third-party service reached only from the deployed
      // Worker — it cannot be exercised from a development sandbox, so its
      // behaviour has to be confirmable from a browser against the real thing.
      // Returns the parsed result for one known address so a wrong assumption
      // about the response format shows up here rather than as a territory of
      // leads at latitude zero.
      if (path === '/api/selftest/geocode') {
        // Accepts an address so a list can be spot-checked before importing it:
        //   /api/selftest/geocode?address=1302+Deepwood+Dr&city=Round+Rock&state=TX&zip=78681
        // Cheaper than discovering a whole territory won't place after uploading
        // it. With no query it falls back to a known address and self-checks the
        // coordinates, which is what catches a changed response format.
        const q = url.searchParams
        const custom = q.get('address')
        try {
          const matches = await geocode([
            custom
              ? {
                  ref: 'probe',
                  address1: custom,
                  city: q.get('city') ?? undefined,
                  state: q.get('state') ?? undefined,
                  zip: q.get('zip') ?? undefined,
                }
              : {
                  ref: 'probe',
                  address1: '1600 Pennsylvania Ave NW',
                  city: 'Washington',
                  state: 'DC',
                  zip: '20500',
                },
          ])
          const m = matches[0]
          return json(
            {
              ok: m?.status === 'match',
              parsed: m ?? null,
              // Sanity-checked against a location we know: if this reads false
              // for the default address, the response format changed or lat/lng
              // arrived swapped. Only meaningful without a custom address.
              looksRight: custom
                ? undefined
                : m?.status === 'match' &&
                  Math.abs((m.lat ?? 0) - 38.9) < 1 &&
                  Math.abs((m.lng ?? 0) + 77.0) < 1,
            },
            200,
            cors,
          )
        } catch (err) {
          return json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            502,
            cors,
          )
        }
      }

      /* --- health -------------------------------------------------------- */
      //
      // Reports which bindings and secrets the *running* Worker can see, so a
      // misconfigured deployment is diagnosable from a browser instead of by
      // guessing. Presence and counts only — never a value, not even a prefix.
      if (path === '/api/health') {
        return json(
          {
            ok: true,
            time: Date.now(),
            config: {
              d1: !!env.DB,
              r2: !!env.PHOTOS,
              sessionPepper: !!env.SESSION_PEPPER,
              setupToken: !!env.SETUP_TOKEN,
              appUrl: env.APP_URL ?? null,
              allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean).length,
              maxImportRows: MAX_IMPORT_ROWS,
              geocodeChunk: GEOCODE_CHUNK,
            },
          },
          200,
          cors,
        )
      }

      /* --- auth ---------------------------------------------------------- */
      if (path === '/api/auth/login' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const email = typeof body.email === 'string' ? body.email : ''
        const password = typeof body.password === 'string' ? body.password : ''
        if (!email || !password) {
          return json({ error: 'Email and password are required.' }, 400, cors)
        }
        const result = await login(env, email, password)
        // Deliberately identical for a wrong email and a wrong password.
        if (!result) return json({ error: 'Incorrect email or password.' }, 401, cors)
        return json(result, 200, cors)
      }

      if (path === '/api/auth/logout' && req.method === 'POST') {
        const token = bearerToken(req)
        if (token) await revokeSession(env, token)
        return json({ ok: true }, 200, cors)
      }

      /* --- everything below needs a session ------------------------------ */
      const user = await requireUser(req, env)
      if (!user) return json({ error: 'Not signed in.' }, 401, cors)

      if (path === '/api/me') {
        return json({ user }, 200, cors)
      }

      if (path === '/api/bootstrap' && req.method === 'GET') {
        return json(await bootstrap(env, user), 200, cors)
      }

      /* --- invitations ---------------------------------------------------- */
      if (path === '/api/invites' && req.method === 'POST') {
        // Managers can see their team; only admins can create access to it.
        if (!canInvite(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        // The invite page is served by *this* Worker, not the React app, so the
        // link must carry the Worker's own origin. Building it from APP_URL sends
        // every invited rep to a URL that has no route for it.
        const created = await createInvite(env, user, url.origin, {
          email: String(body.email ?? ''),
          name: String(body.name ?? ''),
          role: (String(body.role ?? 'field_rep') as Role),
          phone: body.phone ? String(body.phone) : undefined,
        })
        if ('error' in created) return json({ error: created.error }, created.status, cors)
        return json(created, 200, cors)
      }

      if (path === '/api/mutations' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { mutations?: Mutation[] }
        const mutations = Array.isArray(body.mutations) ? body.mutations : []
        if (mutations.length === 0) return json({ results: [] }, 200, cors)
        // Bounded so a rep returning from a long dead zone doesn't send a batch
        // that exceeds the Worker's time limit and fails as a whole.
        if (mutations.length > 200) {
          return json({ error: 'Batch too large; send at most 200.' }, 413, cors)
        }
        const results = await applyMutations(env, user, mutations)
        return json({ results, serverTime: Date.now() }, 200, cors)
      }

      /* --- the team roster ------------------------------------------------ */
      //
      // Not part of bootstrap: a rep has no business holding a list of their
      // colleagues' accounts, and the console is the only thing that needs it.
      if (path === '/api/users' && req.method === 'GET') {
        if (!canImport(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const rows = await env.DB.prepare(
          `SELECT id, name, email, role, phone, active,
                  CASE WHEN password_hash IS NULL THEN 1 ELSE 0 END AS pending
             FROM users WHERE client_id = ?1 ORDER BY name`,
        )
          .bind(user.clientId)
          .all()
        return json(
          {
            users: (rows.results as Record<string, unknown>[]).map((u) => ({
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
              phone: u.phone ?? undefined,
              active: !!u.active,
              // An invited user who hasn't set a password yet. The console shows
              // this so an admin can tell "hasn't accepted" from "isn't working".
              pending: !!u.pending,
            })),
          },
          200,
          cors,
        )
      }

      /* --- lead import ----------------------------------------------------- */
      if (path === '/api/import/geocode' && req.method === 'POST') {
        if (!canImport(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as { rows?: GeocodeRequest[] }
        const rows = Array.isArray(body.rows) ? body.rows : []
        if (rows.length === 0) return json({ matches: [] }, 200, cors)
        if (rows.length > GEOCODE_CHUNK) {
          return json({ error: `Send at most ${GEOCODE_CHUNK} addresses.` }, 413, cors)
        }
        try {
          return json({ matches: await geocode(rows) }, 200, cors)
        } catch (err) {
          // A geocoder outage must not read as "these addresses are bad". The
          // console needs to distinguish "couldn't look them up" from "looked
          // them up and found nothing", because the first one is worth retrying.
          console.error('geocode failed', err)
          return json(
            {
              error: 'The address lookup service is unavailable. Try again shortly.',
              code: 'geocoder_unavailable',
            },
            502,
            cors,
          )
        }
      }

      if (path === '/api/territories/assign' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        // `null` is meaningful on both fields — it addresses the unassigned
        // bucket, and it un-assigns a rep. Neither can be treated as "missing".
        const result = await assignTerritory(env, user, {
          territoryId: typeof body.territoryId === 'string' ? body.territoryId : null,
          repId: typeof body.repId === 'string' && body.repId ? body.repId : null,
        })
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }

      if (path === '/api/import/properties' && req.method === 'POST') {
        if (!canImport(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as ImportInput
        const result = await importProperties(env, user, body)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }

      /* --- photo upload --------------------------------------------------- */
      //
      // Degrades honestly when R2 isn't bound: the client is told storage is
      // unavailable rather than getting a success it can act on. Photos stay in
      // the phone's local cache, which is where they already live — so nothing
      // is lost, it just hasn't uploaded yet.
      if (path.startsWith('/api/photos/') && !env.PHOTOS) {
        return json(
          { error: 'Photo storage is not enabled on this deployment.', code: 'no_photo_storage' },
          503,
          cors,
        )
      }

      if (path.startsWith('/api/photos/') && req.method === 'POST') {
        const photoId = path.slice('/api/photos/'.length)
        const row = await env.DB.prepare(
          'SELECT r2_key FROM photos WHERE id = ?1 AND client_id = ?2',
        )
          .bind(photoId, user.clientId)
          .first<{ r2_key: string }>()
        // The metadata mutation must land first; that's what proves the photo
        // belongs to a property in this tenant.
        if (!row) return json({ error: 'Unknown photo.' }, 404, cors)

        const body = await req.arrayBuffer()
        if (body.byteLength > 8_000_000) {
          return json({ error: 'Photo too large.' }, 413, cors)
        }
        await env.PHOTOS!.put(row.r2_key, body, {
          httpMetadata: { contentType: req.headers.get('content-type') ?? 'image/jpeg' },
        })
        return json({ ok: true, key: row.r2_key }, 200, cors)
      }

      if (path.startsWith('/api/photos/') && req.method === 'GET') {
        const photoId = path.slice('/api/photos/'.length)
        const row = await env.DB.prepare(
          'SELECT r2_key FROM photos WHERE id = ?1 AND client_id = ?2',
        )
          .bind(photoId, user.clientId)
          .first<{ r2_key: string }>()
        if (!row) return new Response('Not found', { status: 404, headers: cors })
        const object = await env.PHOTOS!.get(row.r2_key)
        if (!object) return new Response('Not found', { status: 404, headers: cors })
        return new Response(object.body, {
          headers: {
            ...cors,
            'content-type': object.httpMetadata?.contentType ?? 'image/jpeg',
            'cache-control': 'private, max-age=31536000, immutable',
          },
        })
      }

      return json({ error: 'Not found.' }, 404, cors)
    } catch (err) {
      // Never leak internals to a client; the rep can't act on a stack trace.
      console.error('unhandled', err)
      return json({ error: 'Something went wrong.' }, 500, cors)
    }
  },
} satisfies ExportedHandler<Env>
