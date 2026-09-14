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
  resendInvite,
  revokeInvite,
  runSetup,
} from './invites'
import {
  GEOCODE_CHUNK,
  geocode,
  useCensusBase,
  type GeocodeAttempt,
  type GeocodeRequest,
} from './geocode'
import { useGoogleBase } from './geocode-google'
import { findProvider } from './geocode-providers'
import { MAX_IMPORT_ROWS, canImport, importProperties, type ImportInput } from './import'
import { assignProperties, assignTerritory } from './assign'
import { createTerritory } from './territories'
import { createList, deleteList, listsFor, setReps, updateList, updateMembers } from './lists'
import { readAudit, record as recordAudit } from './audit'
import {
  createResetLink,
  deleteUser,
  footprint,
  setActive,
  setPassword,
  setRole,
  regenerateBadge,
  renewBadge,
  resetOnboarding,
  setUserTeam,
  setUserTitle,
} from './users'
import {
  completeStep,
  confirmBadge,
  mintBadge,
  readOnboarding,
  renewOwnBadge,
  updateProfile,
} from './onboardingFlow'
import { readMe, touchLastSeen } from './me'
import { createTeam, deleteTeam, listTeams, renameTeam } from './teams'
import { updateCompany } from './company'
import { mailConfigured, mailProvider } from './mail'
import { disableJoinCode, joinWithCode, readJoinLink, rotateJoinCode } from './join'
import { verifyBadge } from './verify'
import { badgeStatus, displayName, invitationStatus, onboardingStatus } from './onboarding'
import { ensureSchema, migrationState } from './migrate'
import {
  geocodeKeysFor,
  listGeocoders,
  recordLookups,
  removeGeocoder,
  saveGeocoderKey,
  setActiveGeocoder,
} from './geocoders'
import {
  logResponse,
  logUnhandled,
  newRequestId,
  noteFailure,
  recentFailures,
  routeOf,
  traceHeaders,
  type RequestContext,
} from './observe'
import { applyMutations } from './mutations'
import { readSettings, writeSettings, writeTimezone } from './settings'
import { drainOutbox } from './crm-push'
import { BUILT_AT, COMMIT, DIRTY } from './version'
import { BACKUP_CRON, BackupNotConfigured, canSeeBackups, latestBackup, runBackup } from './backup'
import { eraseProperties, eraseProperty } from './erase'
import { setLeadStatus } from './lead-edit'
import { canReviewConflicts, listConflicts, reviewConflict } from './stale'
import { applyInbound, clientForSecret, webhookSecret } from './crm-inbound'
import {
  canManageIntegrations,
  connectIntegration,
  disconnectIntegration,
  queueDepth,
  readIntegration,
  setGhlCalendar,
} from './integrations'
import { checkLoginRate, clearFailures, recordFailure } from './ratelimit'
import { directions } from './directions'
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

/**
 * Every JSON reply, tagged with the request id and counted if it failed.
 *
 * Centralised here rather than at each return site: there are forty of those and
 * the one that gets forgotten is always the one you needed a log line for.
 */
/**
 * The codes a client may relabel. Structural, and therefore in the source rather
 * than the database: reporting and a year of history key off them, so a settings
 * write must not be able to invent or remove one.
 */
const OUTCOME_CODES = [
  'no_answer',
  'interested',
  'follow_up',
  'appointment',
  'quote_requested',
  'not_interested',
  'sold',
  'do_not_contact',
]
const PHOTO_CATEGORY_KEYS = [
  'property',
  'roof',
  'damage',
  'interior',
  'document',
  'before',
  'after',
]

const reply = (ctx: RequestContext) =>
  (body: unknown, status = 200, headers: HeadersInit = {}) => {
    if (status >= 500) noteFailure()
    logResponse(ctx, status)
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...traceHeaders(ctx),
        ...headers,
      },
    })
  }

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim())
  /*
    Echo only an origin we know.

    This comment used to say a wildcard "would let any site on the internet
    drive this API with a rep's credentials." That is the argument for a
    cookie-authenticated API, and it is wrong for this one. Sessions here are
    `Authorization: Bearer` and nothing else — no cookies anywhere — so a
    browser never attaches a rep's credential to a request from someone else's
    page, and cross-origin script cannot read the token out of this app's
    storage either. A wildcard would not hand anybody a session.

    The reasoning mattered enough to fix, because a security rule defended by an
    argument that does not hold is a rule the next person talks themselves out
    of. What the allowlist actually buys:

      Everything reachable *without* a token becomes readable by any page on the
      internet under a wildcard — sign-in responses, health, the setup and invite
      pages. Individually small, collectively a free reconnaissance surface.

      It bounds the damage if authentication ever changes. The day anything moves
      to a cookie, or a token lands somewhere cross-origin script can reach, a
      wildcard turns a contained mistake into a general one. This costs nothing
      to keep correct now and is expensive to retrofit under pressure.

    What it does NOT buy, and must not be mistaken for: protection against a
    script. CORS is a rule browsers apply to themselves; curl ignores it
    entirely. Anything that needs to be closed to a script has to be closed by
    authentication — see `diagnosticsAllowed` below, which exists because that
    distinction was got wrong once already.
  */
  if (!origin || !allowed.includes(origin)) {
    /*
      Said out loud, once per rejected origin, because the symptom is silent.

      Every response then goes out with no CORS headers, the browser discards
      each one, and the app reports something about the network — so the log is
      the only place the actual cause appears. Naming the origin and the list it
      was compared against turns "nobody can sign in" into a one-line fix in
      `wrangler tail`.

      Only when an origin was sent: a Worker-to-Worker call or a `curl` has none
      and is not a misconfiguration, so logging those would bury the real one.
    */
    if (origin) {
      console.warn(
        `CORS: refused origin ${origin}; ALLOWED_ORIGINS holds ${
          allowed.filter(Boolean).length
        } entr${allowed.filter(Boolean).length === 1 ? 'y' : 'ies'}`,
      )
    }
    return {}
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
    // So the browser can read the id off a failed request and show it to the
    // person looking at the screen. Without this the header exists but is
    // invisible to the app, which defeats the point of returning it.
    'access-control-expose-headers': 'x-request-id',
    vary: 'origin',
  }
}

/**
 * Guard for the diagnostic endpoints, which sit in front of authentication.
 *
 * They are there deliberately: the questions they answer — "is password
 * hashing working on this deployment", "does the geocoder still parse an
 * address the way it used to" — are exactly the ones worth asking when nobody
 * can sign in. Requiring a session would make them useless in the case they
 * exist for.
 *
 * That is not a reason to leave them open, and one of them was. Anyone with
 * curl could hand /api/selftest/geocode an address and make this Worker spend
 * the deployment's Google quota, in a loop, at list price. CORS does not help:
 * it is a browser rule and a script ignores it.
 *
 * So they take the same SETUP_TOKEN the first-run page uses — a secret that
 * already exists, is already handled as a secret, and is held by exactly the
 * people who have reason to run a diagnostic. With no token configured the
 * endpoints refuse rather than defaulting open, because a deployment that
 * forgot to set one is the deployment least able to notice the bill.
 */
function diagnosticsAllowed(req: Request, env: Env): boolean {
  const expected = env.SETUP_TOKEN
  if (!expected) return false
  const given =
    new URL(req.url).searchParams.get('token') ??
    req.headers.get('x-setup-token') ??
    ''
  // Length-independent comparison is not worth it here: the token is not
  // derived from anything, and a wrong guess costs the attacker a round trip
  // either way.
  return given === expected
}

async function requireUser(req: Request, env: Env): Promise<SessionUser | null> {
  const token = bearerToken(req)
  if (!token) return null
  return resolveSession(env, token)
}

/**
 * The nightly backup, and what it says when it does not happen.
 *
 * Every outcome ends in the log, including the boring one. A scheduled job that
 * only speaks up on failure is a job whose silence means either "fine" or "not
 * running", and nobody can tell which from outside — which is the exact state
 * this whole feature exists to end. The success line carries the object key and
 * the size, so `wrangler tail` answers "did last night's backup happen, and was
 * it the right size" without opening the bucket.
 *
 * A missing bucket or key is reported differently from a failed dump on purpose.
 * One is a deployment that was never finished and stays broken until a person
 * does something; the other is a run that may well succeed tomorrow.
 */
async function scheduledBackup(env: Env): Promise<void> {
  try {
    const report = await runBackup(env)
    console.log('backup ok', report)
  } catch (err) {
    if (err instanceof BackupNotConfigured) {
      console.error(`backup NOT CONFIGURED — no backup was taken. ${err.message}`)
      return
    }
    /*
      Not rethrown. Cloudflare would retry on its own clock, and a retry that
      re-reads the whole database is not free — the next scheduled run is close
      enough, and a night without a backup is a thing to see in the log rather
      than to paper over.
    */
    console.error('backup FAILED — no backup was taken.', String(err))
  }
}

export default {
  /**
   * Everything that runs without somebody asking for it.
   *
   * Two schedules, and the branch matters. The CRM drain runs every five
   * minutes; the database backup runs once a night. Running the backup on the
   * five-minute tick would be 288 dumps a day, and running the drain once a
   * night would put a rep's lead in the office CRM sometime tomorrow — so this
   * dispatches on which expression fired rather than doing both on every tick.
   *
   * An unrecognised expression takes the drain. `wrangler dev --test-scheduled`
   * fires with no cron at all, and so does a hand-triggered run from the
   * dashboard; the harmless, idempotent, every-five-minutes job is the right
   * thing to do when the answer is unclear, and taking a full backup would be
   * the wrong one.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === BACKUP_CRON) {
      ctx.waitUntil(scheduledBackup(env))
      return
    }

    /*
      Failures are swallowed on purpose. A scheduled handler that throws is a
      retry Cloudflare decides the timing of, on top of the backoff the outbox
      already implements — two retry schedules fighting each other over the same
      customer's API quota. `drainOutbox` records every failure against its own
      row and against the customer's integration, which is where an admin looks.
    */
    ctx.waitUntil(
      drainOutbox(env, { limit: 100 })
        .then((r: { claimed: number }) => {
          if (r.claimed) console.log('crm drain', r)
        })
        .catch((err: unknown) => console.error('crm drain failed', String(err))),
    )
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env)

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    const ctx: RequestContext = {
      id: newRequestId(),
      method: req.method,
      route: routeOf(path),
      started: Date.now(),
    }
    const json = reply(ctx)

    // Once per isolate, and a no-op after the first deploy that applied
    // everything. Schema changes ship with the code rather than waiting for
    // somebody to remember to paste them into a console.
    await ensureSchema(env)

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

      /*
        The link shape the setup brief writes. Minting still produces
        /invite/TOKEN — one canonical URL, one page, one form target — so this
        forwards rather than rendering a second copy of the same screen. It
        exists so a link written by hand, or copied out of documentation,
        lands somewhere instead of 404ing.
      */
      if (path === '/onboarding/invite' && req.method === 'GET') {
        const token = url.searchParams.get('token') ?? ''
        // 302, not 301: a browser that cached a permanent redirect for one
        // token would send the next rep to somebody else's invitation.
        return new Response(null, {
          status: 302,
          headers: { location: `/invite/${encodeURIComponent(token)}`, ...cors },
        })
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
        if (!diagnosticsAllowed(req, env)) {
          return json({ error: 'Diagnostics need the setup token.' }, 403, cors)
        }
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
        /*
          Checked before anything else in here, because everything in here
          spends money. This endpoint hands an arbitrary address to a paid
          geocoder and was reachable by anyone on the internet.
        */
        if (!diagnosticsAllowed(req, env)) {
          return json({ error: 'Diagnostics need the setup token.' }, 403, cors)
        }
        // Accepts an address so a list can be spot-checked before importing it:
        //   /api/selftest/geocode?address=1302+Deepwood+Dr&city=Round+Rock&state=TX&zip=78681
        // Cheaper than discovering a whole territory won't place after uploading
        // it. With no query it falls back to a known address and self-checks the
        // coordinates, which is what catches a changed response format.
        const q = url.searchParams
        const custom = q.get('address')
        const probeRow: GeocodeRequest = custom
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
            }

        /*
          `?raw=1` used to report what MapTiler actually said about the probe
          address, variant by variant, for the case where a result was wrong in a
          way the parsed output could not explain. It went with the MapTiler
          geocoder. Nothing equivalent exists for Google or Census and none is
          added here: the diagnostic existed because MapTiler answered a house
          with a street and the parsed output could not show why. `attempts`
          below covers what remains — which provider was asked, what it placed,
          and its own words when it refused.
        */

        try {
          // Every provider's attempt is reported, not just the winner. Without
          // this a provider rejecting every request is invisible: the chain
          // degrades to the next one, the probe succeeds, and the only symptom is
          // that the result came from further down than it should have.
          const attempts: GeocodeAttempt[] = []
          const matches = await geocode(
            [probeRow],
            { google: env.GOOGLE_MAPS_API_KEY },
            attempts,
          )
          const m = matches[0]
          return json(
            {
              ok: m?.status === 'match',
              parsed: m ?? null,
              attempts,
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
            /*
              Which commit is actually running.

              Not a nicety. A build token belonging to somebody who had left the
              organisation broke every Worker deploy for nine days, while
              Cloudflare Pages kept deploying — so the front end moved, the API
              did not, and nothing anywhere said so. A Worker cannot tell it is
              stale; it serves the version it was given exactly as well as it
              did on day one. This turns "is production current" into a `curl`
              and a `git log`.

              On the unauthenticated endpoint deliberately, because a check that
              needs a credential is a check nobody runs from a phone at the point
              they are wondering. It names a commit in a private repository and
              nothing about a customer, which is the same bar the rest of this
              payload meets.

              `commit: null` means the build was never stamped — distinct from a
              stamped build, and worth telling apart. `dirty` means somebody
              deployed from a working tree with uncommitted changes, so the sha
              describes the commit they were sitting on rather than what is
              running.
            */
            version: { commit: COMMIT, builtAt: BUILT_AT, dirty: DIRTY },
            config: {
              d1: !!env.DB,
              r2: !!env.PHOTOS,
              /*
                Both halves, because either one missing means the nightly backup
                silently does not happen — and a backup that has never run looks
                from outside exactly like one that runs every night. Presence
                only: no timestamp, no size, no object names. Whether backups are
                configured is an operational fact; when the last one was taken
                and how big it is describes the database, and this endpoint is
                unauthenticated.
              */
              backupBucket: !!env.BACKUPS,
              backupKey: !!env.BACKUP_KEY,
              sessionPepper: !!env.SESSION_PEPPER,
              setupToken: !!env.SETUP_TOKEN,
              // Present means rooftop geocoding via Google; absent means the
              // free Census geocoder, which places a house on the right block.
              // `maptilerGeocoding` was reported here until MapTiler left the
              // chain. The Worker needs no MapTiler key at all now — if one is
              // still set as a secret it is unused, and deleting it is safe.
              googleGeocoding: !!env.GOOGLE_MAPS_API_KEY,
              // Absent means connecting a CRM is refused rather than storing a
              // customer's token in plaintext — a deliberate refusal, but one
              // that is otherwise indistinguishable from a broken integration.
              integrationKey: !!env.INTEGRATION_KEY,
              // Present means invitations are emailed; absent means the console
              // hands the admin a link to send. Both work — but an admin who
              // believes email is on when it is not finds out a week later.
              mail: mailConfigured(env),
              // Which provider, so "did that go through Resend?" is answerable
              // from outside. A name, never a key.
              mailProvider: mailProvider(env),
              appUrl: env.APP_URL ?? null,
              allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean).length,
              // Surfaced because a failed migration is otherwise invisible:
              // the deploy succeeds and one feature quietly doesn't work.
              migrations: migrationState(),
              // Approximate and per-isolate — a smoke alarm, not an accounting
              // record. Non-zero is worth a look; zero proves nothing.
              recentFailures: recentFailures(),
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

        // Checked before hashing, not after: the whole point is to stop paying
        // the CPU cost of a guess we've already decided not to answer.
        const ip = req.headers.get('cf-connecting-ip')
        const limit = await checkLoginRate(env, email, ip)
        if (!limit.allowed) {
          return json(
            {
              error: 'Too many sign-in attempts. Wait a few minutes and try again.',
              code: 'rate_limited',
            },
            429,
            { ...cors, 'retry-after': String(limit.retryAfter ?? 900) },
          )
        }

        const result = await login(env, email, password)
        if (!result) {
          await recordFailure(env, email, ip)
          // Deliberately identical for a wrong email and a wrong password.
          return json({ error: 'Incorrect email or password.' }, 401, cors)
        }
        // A correct password means this was never an attack; don't leave the
        // bucket primed to lock out the person who just proved who they are.
        await clearFailures(env, email, ip)
        await touchLastSeen(env, result.user.id)
        // The full person — profile, onboarding, badge, company — not just the
        // session's eight fields, so the app knows on arrival whether to open
        // onboarding or the map. A strict superset of what this returned before.
        //
        // And never the reason sign-in fails. `readMe` reads columns migration
        // 016 adds; on a database where that migration failed, the session user
        // goes out as it always did and the failure stays where it is reported,
        // in /api/health — sabotaging the runner proved this returned a 500.
        const me = await readMe(env, result.user.id).catch((err) => {
          console.error('readMe failed at sign-in; sending the session user', String(err))
          return null
        })
        return json({ token: result.token, user: me ?? result.user }, 200, cors)
      }

      /*
        Redeeming a company join code. Public by necessity — the person has no
        account yet — and rate-limited inside `joinWithCode` on the same buckets
        as a password guess, because the code is the only thing between the
        internet and a field-rep account in somebody's company.
      */
      /* --- a badge, checked by the homeowner it was shown to ----------------- */
      //
      // Public and rate-limited like /api/join, for the same reason: no login
      // exists for the person asking, and a miss costs an attempt.
      if (path === '/api/verify' && req.method === 'GET') {
        const result = await verifyBadge(env, url.searchParams.get('badge'), req.headers.get('cf-connecting-ip'))
        if ('error' in result) {
          const headers = result.retryAfter ? { ...cors, 'retry-after': String(result.retryAfter) } : cors
          return json({ error: result.error }, result.status, headers)
        }
        return json(result, 200, cors)
      }

      if (path === '/api/join' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await joinWithCode(env, body, req.headers.get('cf-connecting-ip'))
        if ('error' in result) {
          const headers = result.retryAfter ? { ...cors, 'retry-after': String(result.retryAfter) } : cors
          return json({ error: result.error, code: result.code }, result.status, headers)
        }
        return json(result, 201, cors)
      }

      if (path === '/api/auth/logout' && req.method === 'POST') {
        const token = bearerToken(req)
        if (token) await revokeSession(env, token)
        return json({ ok: true }, 200, cors)
      }

      /*
        Leads arriving from GoHighLevel.

        Above the session boundary on purpose: GoHighLevel has no Allstar login
        and never will. The URL itself is the credential — a 64-character secret,
        per company, rotatable — and that secret is what decides whose data this
        is. The payload's `locationId` is checked against the one on file but is
        never used to choose a tenant, because every byte of a webhook body is
        controlled by whoever sent it.

        Answers 200 for anything it declines to act on. A webhook that returns an
        error gets retried by the sender, and retrying a payload we have decided
        to ignore is load on both sides with no outcome either way. Only a bad
        secret is refused outright, and it is refused without saying why.
      */
      {
        const hook = /^\/api\/webhooks\/ghl\/([a-f0-9]{64})$/.exec(path)
        if (hook && req.method === 'POST') {
          const owner = await clientForSecret(env, hook[1])
          if (!owner) return json({ error: 'Not found.' }, 404, cors)
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          try {
            const outcome = await applyInbound(env, owner, body)
            return json(outcome, 200, cors)
          } catch (err) {
            /*
              A 500 here would have GoHighLevel retry, which is right — this is
              the one case where losing the lead is worse than repeating the
              work, and the handler is idempotent: the property id is derived
              from the address, so a replay updates rather than duplicating.
            */
            console.error('inbound webhook failed', String(err))
            return json({ error: 'Could not apply that update.' }, 500, cors)
          }
        }
      }

      /* --- everything below needs a session ------------------------------ */
      const user = await requireUser(req, env)
      if (!user) return json({ error: 'Not signed in.' }, 401, cors)

      if (path === '/api/me') {
        // Same fallback as sign-in: a failed migration must not make "who am I"
        // unanswerable.
        const me = await readMe(env, user.id).catch(() => null)
        return json({ user: me ?? user }, 200, cors)
      }

      /* --- my own onboarding and badge ------------------------------------ */
      //
      // Every one of these acts on the signed-in person and nobody else — the
      // handlers take `user.id` and no other id. The admin's versions of reset,
      // renew and regenerate are under /api/users/:id, behind the guard.
      if (path === '/api/me/onboarding' && req.method === 'GET') {
        const result = await readOnboarding(env, user)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }
      if (path === '/api/me/onboarding/step' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await completeStep(env, user, body)
        if ('error' in result) return json({ error: result.error, missing: result.missing }, result.status, cors)
        return json(result, 200, cors)
      }
      if (path === '/api/me/profile' && req.method === 'PATCH') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await updateProfile(env, user, body)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json({ user: result }, 200, cors)
      }
      if (path === '/api/me/badge' && req.method === 'POST') {
        const result = await mintBadge(env, user)
        if (result && 'error' in result) return json({ error: result.error, missing: result.missing }, result.status, cors)
        return json({ badge: result }, 200, cors)
      }
      if (path === '/api/me/badge/confirm' && req.method === 'POST') {
        const result = await confirmBadge(env, user)
        if (result && 'error' in result) return json({ error: result.error }, result.status, cors)
        return json({ badge: result }, 200, cors)
      }
      if (path === '/api/me/badge/renew' && req.method === 'POST') {
        const result = await renewOwnBadge(env, user)
        if (result && 'error' in result) return json({ error: result.error }, result.status, cors)
        return json({ badge: result }, 200, cors)
      }

      if (path === '/api/bootstrap' && req.method === 'GET') {
        await touchLastSeen(env, user.id)
        return json(await bootstrap(env, user), 200, cors)
      }

      /* --- one walking route --------------------------------------------- */
      //
      // On the Worker rather than in the browser because the browser key is
      // restricted to Maps JS, Places and Street View — a leak of the key in the
      // bundle cannot spend routing quota. This costs one hop to keep that true.
      if (path === '/api/directions' && req.method === 'POST') {
        const result = await directions(env, await req.json().catch(() => ({})))
        return result.ok
          ? json({ leg: result.leg }, 200, cors)
          : json({ error: result.error }, result.status, cors)
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
          role: (String(body.role ?? 'field_rep') as Role),
          name: body.name,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          jobTitle: body.jobTitle,
          teamId: body.teamId,
        }, appUrl)
        if ('error' in created) return json({ error: created.error }, created.status, cors)
        return json(created, 200, cors)
      }

      {
        const m = /^\/api\/invites\/([A-Za-z0-9_-]{1,40})\/(resend|revoke)$/.exec(path)
        if (m && req.method === 'POST') {
          const result =
            m[2] === 'resend'
              ? await resendInvite(env, user, url.origin, m[1]!, appUrl)
              : await revokeInvite(env, user, m[1]!)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }
      }

      /* --- the company join link ------------------------------------------- */
      //
      // Admin only, all three: the code is a credential for making accounts in
      // this company, and reading it is handing it out.
      if (path === '/api/join-link' && req.method === 'GET') {
        const result = await readJoinLink(env, user, appUrl)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }
      if (path === '/api/join-link' && req.method === 'POST') {
        const result = await rotateJoinCode(env, user, appUrl)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }
      if (path === '/api/join-link' && req.method === 'DELETE') {
        const result = await disableJoinCode(env, user)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
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
        await touchLastSeen(env, user.id)
        return json({ results, serverTime: Date.now() }, 200, cors)
      }

      /* --- the team roster ------------------------------------------------ */
      //
      // Not part of bootstrap: a rep has no business holding a list of their
      // colleagues' accounts, and the console is the only thing that needs it.
      if (path === '/api/users' && req.method === 'GET') {
        if (!canImport(user)) return json({ error: 'Not permitted.' }, 403, cors)
        /*
          One row per person with the facts three statuses are derived from.
          The newest *invitation* token rides along (never a reset link — those
          share the table, see schema.sql) so "did they ever get their link" is
          answerable without a second query per person.
        */
        const rows = await env.DB.prepare(
          `SELECT u.id, u.name, u.first_name, u.last_name, u.email, u.role, u.phone, u.active,
                  u.job_title, u.team_id, t.name AS team_name, u.created_at, u.last_seen_at,
                  u.onboarding_step, u.onboarding_version, u.onboarding_completed_at,
                  u.badge_id, u.badge_expires_at, u.badge_confirmed_at,
                  CASE WHEN u.password_hash IS NULL THEN 1 ELSE 0 END AS pending,
                  i.accepted_at AS inv_accepted_at, i.revoked_at AS inv_revoked_at,
                  i.expires_at AS inv_expires_at, i.created_at AS inv_created_at,
                  -- When they were FIRST asked, and how many times. The joined
                  -- row above is the newest link; on its own it cannot tell
                  -- "invited on Monday" from "invited Monday, chased Thursday",
                  -- which is the difference an admin is looking at the list to
                  -- see. Revoked and expired tokens count: they were still sends.
                  (SELECT MIN(created_at) FROM invites
                    WHERE user_id = u.id AND kind = 'invite') AS inv_first_at,
                  (SELECT COUNT(*) FROM invites
                    WHERE user_id = u.id AND kind = 'invite') AS inv_sends
             FROM users u
             LEFT JOIN teams t ON t.id = u.team_id
             LEFT JOIN invites i ON i.token_hash = (
               SELECT token_hash FROM invites
                WHERE user_id = u.id AND kind = 'invite'
                ORDER BY created_at DESC LIMIT 1)
            WHERE u.client_id = ?1 ORDER BY u.name`,
        )
          .bind(user.clientId)
          .all()
        const now = Date.now()
        return json(
          {
            users: (rows.results as Record<string, string | number | null>[]).map((u) => {
              const facts = {
                name: u.name == null ? null : String(u.name),
                first_name: u.first_name == null ? null : String(u.first_name),
                last_name: u.last_name == null ? null : String(u.last_name),
                onboarding_step: u.onboarding_step == null ? null : String(u.onboarding_step),
                onboarding_version: Number(u.onboarding_version ?? 0),
                onboarding_completed_at:
                  u.onboarding_completed_at == null ? null : Number(u.onboarding_completed_at),
                badge_id: u.badge_id == null ? null : String(u.badge_id),
                badge_expires_at: u.badge_expires_at == null ? null : Number(u.badge_expires_at),
                badge_confirmed_at:
                  u.badge_confirmed_at == null ? null : Number(u.badge_confirmed_at),
              }
              const invite =
                u.inv_created_at == null
                  ? null
                  : {
                      accepted_at: u.inv_accepted_at == null ? null : Number(u.inv_accepted_at),
                      revoked_at: u.inv_revoked_at == null ? null : Number(u.inv_revoked_at),
                      expires_at: Number(u.inv_expires_at),
                    }
              return {
                id: u.id,
                name: displayName({ ...facts, email: String(u.email) }),
                firstName: u.first_name ?? undefined,
                lastName: u.last_name ?? undefined,
                email: u.email,
                role: u.role,
                phone: u.phone ?? undefined,
                jobTitle: u.job_title ?? undefined,
                teamId: u.team_id ?? undefined,
                teamName: u.team_name ?? undefined,
                active: !!u.active,
                // An invited user who hasn't set a password yet. The console shows
                // this so an admin can tell "hasn't accepted" from "isn't working".
                pending: !!u.pending,
                invitation: invitationStatus(invite, now),
                invitedAt: u.inv_first_at == null ? undefined : Number(u.inv_first_at),
                // Only when there was a chase — otherwise it is the same act
                // twice on screen, and a date that means nothing new.
                resentAt: Number(u.inv_sends ?? 0) > 1 ? Number(u.inv_created_at) : undefined,
                onboarding: onboardingStatus(facts, now),
                onboardingStep: facts.onboarding_step ?? undefined,
                badge: badgeStatus(facts, now),
                badgeExpiresAt: facts.badge_expires_at ?? undefined,
                createdAt: Number(u.created_at),
                lastSeenAt: u.last_seen_at == null ? undefined : Number(u.last_seen_at),
              }
            }),
          },
          200,
          cors,
        )
      }

      /* --- account management ---------------------------------------------- */
      //
      // /api/users/:id/<action>. Every one of these is guarded inside the module
      // rather than here, so the tenant and last-admin checks can't be forgotten
      // by a future route.
      if (path.startsWith('/api/users/')) {
        const rest = path.slice('/api/users/'.length)
        const [targetId, action] = rest.split('/')
        const a = { env, actor: user, userId: targetId }

        if (action === 'team' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          const result = await setUserTeam(a, typeof body.teamId === 'string' ? body.teamId : null)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }

        if (action === 'title' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          const result = await setUserTitle(a, body.jobTitle)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }

        if (action === 'onboarding-reset' && req.method === 'POST') {
          const result = await resetOnboarding(a)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }

        if (action === 'badge-renew' && req.method === 'POST') {
          const result = await renewBadge(a)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json({ badge: result }, 200, cors)
        }

        if (action === 'badge-regenerate' && req.method === 'POST') {
          const result = await regenerateBadge(a)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json({ badge: result }, 200, cors)
        }

        if (action === 'footprint' && req.method === 'GET') {
          const result = await footprint(a)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }

        if (action === 'password' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          const result = await setPassword(
            a,
            typeof body.password === 'string' ? body.password : '',
          )
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }

        if (action === 'reset-link' && req.method === 'POST') {
          // The Worker serves the page the link points at, so it carries the
          // Worker's origin — not the app's.
          const result = await createResetLink(a, url.origin)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }

        if (action === 'role' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          const result = await setRole(a, String(body.role ?? '') as Role)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }

        if (action === 'active' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          const result = await setActive(a, body.active === true)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }

        if (!action && req.method === 'DELETE') {
          const result = await deleteUser(a)
          if ('error' in result) return json({ error: result.error }, result.status, cors)
          return json(result, 200, cors)
        }
      }

      /* --- client settings -------------------------------------------------- */
      //
      // Readable by anyone signed in — the field app needs the labels — but
      // writable only by an admin.
      if (path === '/api/settings' && req.method === 'GET') {
        return json({ settings: await readSettings(env, user.clientId) }, 200, cors)
      }

      if (path === '/api/settings' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await writeSettings(env, user, body.settings, {
          codes: OUTCOME_CODES,
          categories: PHOTO_CATEGORY_KEYS,
        })
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }

      /* --- a company's own CRM ---------------------------------------------- */
      //
      // Read is admin-only even though it returns no token: the queue depth and
      // the last error say things about a company's operations that a field rep
      // has no reason to see.
      if (path === '/api/integrations' && req.method === 'GET') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const [status, queue] = await Promise.all([
          readIntegration(env, user.clientId),
          queueDepth(env, user.clientId),
        ])
        return json({ integration: status, queue }, 200, cors)
      }

      // Write-only by design — there is no endpoint that hands a stored token
      // back, so connecting means pasting a fresh one rather than editing.
      if (path === '/api/integrations/ghl' && req.method === 'POST') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await connectIntegration(env, user, {
          token: typeof body.token === 'string' ? body.token : '',
          locationId: typeof body.locationId === 'string' ? body.locationId : '',
        })
        if (!result.ok) return json({ error: result.error }, result.status, cors)
        return json({ integration: result.status, locationName: result.locationName }, 200, cors)
      }

      /*
        Send what is queued, now, rather than waiting for the schedule.

        Here because "did my leads reach the CRM?" is a question an admin asks
        while somebody is on the phone to them, and "wait up to five minutes" is
        not an answer. It is also what makes the push path testable end to end
        without a cron: the gate calls this.

        Same permission as connecting, and bounded the same way as the scheduled
        run — an admin holding the button down cannot turn this into an
        unbounded loop against the customer's API quota.
      */
      /*
        Which calendar appointments are booked into.

        Separate from connecting, because it is a setting rather than a
        credential and a company may reasonably never set it — with no calendar,
        appointments are not queued at all rather than queued and failed. An
        empty value clears it, which is how appointment sync gets turned off.
      */
      /*
        The webhook URL an admin pastes into GoHighLevel.

        A GET would be tidier, but creating the secret on first request is a
        write, and a GET that writes is the kind of thing a browser prefetch or a
        link scanner triggers by accident. POST, with `rotate` to replace it —
        which is also the revocation story, since the URL is the credential.
      */
      /*
        Erasing a lead and everything attached to it.

        DELETE with a body, which is unusual but correct here: a reason is
        required and there is nowhere else to put it. The alternative — a reason
        in the query string — writes the customer's stated grounds for an erasure
        into every access log between here and the browser.

        Narrower than importing on purpose. See `canErase`.
      */
      // The same act over a selection. Admin only, a reason, an exact count back.
      if (path === '/api/leads/erase-bulk' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await eraseProperties(env, user, body.propertyIds, body.reason)
        if (!result.ok) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }

      if (path === '/api/leads/erase' && req.method === 'DELETE') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await eraseProperty(
          env,
          user,
          typeof body.propertyId === 'string' ? body.propertyId : '',
          typeof body.reason === 'string' ? body.reason : '',
        )
        if (!result.ok) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }

      /*
        Work that arrived days late onto a lead somebody had since moved.

        The rep's answer already won — that is the rule and it is not in
        question here. This is the record of it, so a manager can go and ask
        rather than find out from the homeowner. See stale.ts.
      */
      if (path === '/api/sync-conflicts' && req.method === 'GET') {
        if (!canReviewConflicts(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const q = new URL(req.url).searchParams
        const conflicts = await listConflicts(env, user.clientId, {
          includeReviewed: q.get('all') === '1',
          limit: Number(q.get('limit')) || undefined,
        })
        return json({ conflicts }, 200, cors)
      }

      if (path === '/api/sync-conflicts/review' && req.method === 'POST') {
        if (!canReviewConflicts(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await reviewConflict(
          env,
          user.clientId,
          typeof body.id === 'string' ? body.id : '',
        )
        if (!result.ok) return json({ error: result.error }, result.status, cors)
        return json({ ok: true }, 200, cors)
      }

      if (path === '/api/integrations/ghl/webhook' && req.method === 'POST') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const secret = await webhookSecret(env, user.clientId, { rotate: body.rotate === true })
        if (!secret) return json({ error: 'No CRM is connected.' }, 404, cors)
        /*
          Absolute, and taken from this request's own origin rather than a
          configured one. An admin pastes this into GoHighLevel, so a relative
          path is useless to them — and APP_URL is the *front-end* address, which
          is a different host from the Worker that has to receive the call.
        */
        const origin = new URL(req.url).origin
        return json({ url: `${origin}/api/webhooks/ghl/${secret}` }, 200, cors)
      }

      if (path === '/api/integrations/ghl/calendar' && req.method === 'PUT') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await setGhlCalendar(
          env,
          user.clientId,
          typeof body.calendarId === 'string' ? body.calendarId : '',
        )
        if (!result.ok) return json({ error: result.error }, result.status, cors)
        return json({ calendarId: result.calendarId ?? null }, 200, cors)
      }

      if (path === '/api/integrations/ghl/drain' && req.method === 'POST') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const report = await drainOutbox(env, { clientId: user.clientId })
        const queue = await queueDepth(env, user.clientId)
        return json({ ...report, queue }, 200, cors)
      }

      if (path === '/api/integrations/ghl' && req.method === 'DELETE') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const result = await disconnectIntegration(env, user)
        return json(result, 200, cors)
      }

      /*
        Geocoding providers.

        Same permission as the CRM connection, and for the same reason: both
        take a customer's own API credential. Write-only in the same way too —
        no endpoint hands a stored key back, so changing one means pasting a
        fresh one rather than editing what is there.
      */
      if (path === '/api/geocoders' && req.method === 'GET') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        return json(await listGeocoders(env, user.clientId), 200, cors)
      }

      if (path === '/api/geocoders/key' && req.method === 'POST') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const provider = typeof body.provider === 'string' ? body.provider : ''
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey) return json({ error: 'Paste the API key first.' }, 400, cors)
        try {
          await saveGeocoderKey(env, user.clientId, provider, apiKey)
        } catch (err) {
          // The message is the provider's own reason or ours, never the key.
          return json({ error: (err as Error).message }, 400, cors)
        }
        await recordAudit(env, user, {
          action: 'geocoder.connected',
          targetType: 'geocoder',
          targetLabel: findProvider(provider)?.label ?? provider,
        })
        return json(await listGeocoders(env, user.clientId), 200, cors)
      }

      if (path === '/api/geocoders/active' && req.method === 'POST') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const provider = typeof body.provider === 'string' ? body.provider : ''
        try {
          await setActiveGeocoder(env, user.clientId, provider)
        } catch (err) {
          return json({ error: (err as Error).message }, 400, cors)
        }
        await recordAudit(env, user, {
          action: 'geocoder.changed',
          targetType: 'geocoder',
          targetLabel: findProvider(provider)?.label ?? provider,
        })
        return json(await listGeocoders(env, user.clientId), 200, cors)
      }

      if (path === '/api/geocoders/key' && req.method === 'DELETE') {
        if (!canManageIntegrations(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const provider = url.searchParams.get('provider') ?? ''
        await removeGeocoder(env, user.clientId, provider)
        await recordAudit(env, user, {
          action: 'geocoder.disconnected',
          targetType: 'geocoder',
          targetLabel: findProvider(provider)?.label ?? provider,
        })
        return json(await listGeocoders(env, user.clientId), 200, cors)
      }

      /*
        The company's calendar. Readable by anyone signed in — the field app has
        to agree with the server about which day it is — and writable only by an
        admin.
      */
      if (path === '/api/settings/timezone' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await writeTimezone(env, user, body.timezone)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }

      /* --- evidence that the nightly backup is happening -------------------- */
      //
      // Super admin alone, and not because the payload is dramatic — a key, a
      // size and a timestamp. It is that the size describes the database and the
      // run of names describes when this deployment was and was not being backed
      // up. `/api/health` stops at "the configuration exists", which stays true
      // through a cron that silently stopped firing; this is the endpoint that
      // can tell those apart, so it sits behind the strongest role there is.
      if (path === '/api/ops/backups' && req.method === 'GET') {
        if (!canSeeBackups(user)) return json({ error: 'Not permitted.' }, 403, cors)
        return json(await latestBackup(env), 200, cors)
      }

      /* --- the audit log ---------------------------------------------------- */
      //
      // Read-only by design. There is no endpoint that deletes from it, because
      // a log the accused can edit is not evidence.
      if (path === '/api/audit' && req.method === 'GET') {
        if (!canInvite(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const limit = Number(url.searchParams.get('limit') ?? 100)
        const beforeParam = url.searchParams.get('before')
        const entries = await readAudit(env, user, {
          limit: Number.isFinite(limit) ? limit : 100,
          before: beforeParam ? Number(beforeParam) : undefined,
        })
        return json({ entries }, 200, cors)
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
          /*
            The company's own provider, when they have chosen one.

            Their choice replaces our paid providers rather than joining them:
            falling back to the deployment's key would mean us quietly paying
            for lookups the screen has just told them they are paying for.
            Census is still underneath, inside `geocode`, because it is free.
          */
          const { keys, provider } = await geocodeKeysFor(env, user.clientId)
          /*
            Both overrides applied here, not just Google's.

            `useCensusBase` was only ever called on the inbound webhook path, so
            this endpoint always talked to the real Census service even when a
            deployment had pointed everything else at a stand-in — which made
            the endpoint that does the actual importing the one that could not be
            driven end to end. Both default to the real services when unset.
          */
          useCensusBase(env.CENSUS_BASE_URL)
          useGoogleBase(env.GOOGLE_GEOCODE_BASE_URL)
          /*
            Which providers were asked, and what they said.

            `geocode` has always been able to report this and only the selftest
            endpoint ever asked for it — so on the path that actually runs, in
            volume, against a customer's list, a key that rejects every request
            was invisible. The chain is built to degrade rather than fail, which
            is right, and the cost of that is a dead key looking exactly like a
            provider that had nothing to add: the import succeeds, every pin
            quietly drops from a rooftop to a block, and the first person who
            could notice is a rep knocking on the wrong door.

            The same shape as the Cloudflare build token that stopped deploying
            this Worker for nine days while every check but one stayed green.
            A credential that fails loudly gets fixed the same day.
          */
          const attempts: GeocodeAttempt[] = []
          const matches = await geocode(rows, keys, attempts)

          /*
            Logged as well as returned. The response reaches the operator who
            started the import, which is the person who most needs it — but only
            while they are looking at that screen. `wrangler tail` is where
            somebody diagnoses it afterwards, and a customer reporting "the pins
            are all wrong" a week later is the likelier way this surfaces.

            The provider's own words, which carry no key: Google's
            `error_message`, or the bare status code.
          */
          for (const a of attempts) {
            if (a.errors > 0 && a.errors === a.asked) {
              console.error(
                `geocode: ${a.provider} rejected all ${a.asked} addresses for client ` +
                  `${user.clientId} — ${a.firstError ?? 'no reason given'}`,
              )
            }
          }

          /*
            Counted after the fact, because the money is spent by the time the
            answer arrives — a refusal here would lose the work without saving
            the charge. Every address sent counts, matched or not: the vendor
            bills for the question, not the answer.
          */
          await recordLookups(env, user.clientId, provider, rows.length)
          return json({ matches, attempts }, 200, cors)
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

      if (path === '/api/properties/assign' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await assignProperties(env, user, {
          propertyIds: Array.isArray(body.propertyIds) ? (body.propertyIds as string[]) : [],
          repId: typeof body.repId === 'string' && body.repId ? body.repId : null,
        })
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }

      /*
        Setting a status on a batch of leads, from the office.

        Deliberately not reachable from the field app: a rep records what
        happened at the door and the status follows, which is what makes every
        status answerable. See lead-edit.ts — the permission and the Do Not
        Contact guard both live in there, so they travel with the function.
      */
      if (path === '/api/leads/status' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await setLeadStatus(env, user, {
          propertyIds: Array.isArray(body.propertyIds) ? (body.propertyIds as string[]) : [],
          status: typeof body.status === 'string' ? body.status : '',
        })
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
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

      if (path === '/api/territories' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        // Passed through unvalidated on purpose: `createTerritory` owns the
        // checks, because it is the thing that has to be safe when the shape
        // arrives from somewhere other than our own console.
        const result = await createTerritory(env, user, {
          name: body.name,
          repId: body.repId,
          boundary: body.boundary,
        })
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 201, cors)
      }

      /* --- lead lists ------------------------------------------------------ */
      //
      // Every route hands its body to lists.ts unvalidated, on purpose: that
      // module owns the checks, because it is also what the offline mutation
      // path calls, and one implementation of "may this person do this" is the
      // whole point. Permission decisions are inside each function and are
      // explicit for every role — see canManageLists and mayEdit there.
      if (path === '/api/lists' && req.method === 'GET') {
        return json({ lists: await listsFor(env, user) }, 200, cors)
      }

      if (path === '/api/lists' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await createList(env, user, body)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 201, cors)
      }

      {
        const m = /^\/api\/lists\/([A-Za-z0-9_-]{1,40})(?:\/(members|reps))?$/.exec(path)
        if (m) {
          const [, id, sub] = m
          if (!sub && req.method === 'PATCH') {
            const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
            const result = await updateList(env, user, id!, body)
            if ('error' in result) return json({ error: result.error }, result.status, cors)
            return json(result, 200, cors)
          }
          if (!sub && req.method === 'DELETE') {
            const result = await deleteList(env, user, id!)
            if ('error' in result) return json({ error: result.error }, result.status, cors)
            return json(result, 200, cors)
          }
          if (sub === 'members' && req.method === 'POST') {
            const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
            const result = await updateMembers(env, user, id!, body)
            if ('error' in result) return json({ error: result.error }, result.status, cors)
            return json(result, 200, cors)
          }
          if (sub === 'reps' && req.method === 'PUT') {
            const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
            const result = await setReps(env, user, id!, body)
            if ('error' in result) return json({ error: result.error }, result.status, cors)
            return json(result, 200, cors)
          }
        }
      }

      /* --- teams and offices ----------------------------------------------- */
      //
      // Read by anyone signed in: a rep's badge names their team. Written by
      // the admins, decided inside teams.ts.
      if (path === '/api/teams' && req.method === 'GET') {
        return json({ teams: await listTeams(env, user.clientId) }, 200, cors)
      }

      if (path === '/api/teams' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await createTeam(env, user, body)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 201, cors)
      }

      {
        const m = /^\/api\/teams\/([A-Za-z0-9_-]{1,40})$/.exec(path)
        if (m) {
          if (req.method === 'PATCH') {
            const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
            const result = await renameTeam(env, user, m[1]!, body)
            if ('error' in result) return json({ error: result.error }, result.status, cors)
            return json(result, 200, cors)
          }
          if (req.method === 'DELETE') {
            const result = await deleteTeam(env, user, m[1]!)
            if ('error' in result) return json({ error: result.error }, result.status, cors)
            return json(result, 200, cors)
          }
        }
      }

      /* --- the company, as it appears on a badge ---------------------------- */
      if (path === '/api/company' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const result = await updateCompany(env, user, body)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json({ company: result }, 200, cors)
      }

      if (path === '/api/import/properties' && req.method === 'POST') {
        if (!canImport(user)) return json({ error: 'Not permitted.' }, 403, cors)
        const body = (await req.json().catch(() => ({}))) as ImportInput
        const result = await importProperties(env, user, body)
        if ('error' in result) return json({ error: result.error }, result.status, cors)
        return json(result, 200, cors)
      }

      /* --- a property's photos --------------------------------------------- */
      //
      // Metadata only, and deliberately not part of bootstrap.
      //
      // A rep's own photos are already on their phone — this endpoint exists for
      // the ones a device never took: the office opening a roof shot, or a rep
      // on a replaced handset. Fetching those needs the network by definition,
      // so there is nothing to gain from carrying every photo row in the payload
      // that every rep refreshes on every launch, and a lot of bytes to lose.
      //
      // Scoped by property rather than by role: the tenant check is the whole
      // authorization, and it is the same one the mutations use.
      if (/^\/api\/properties\/[^/]+\/photos$/.test(path) && req.method === 'GET') {
        const propertyId = path.slice('/api/properties/'.length, -'/photos'.length)
        const owner = await env.DB.prepare(
          'SELECT 1 AS ok FROM properties WHERE id = ?1 AND client_id = ?2',
        )
          .bind(propertyId, user.clientId)
          .first<{ ok: number }>()
        if (!owner) return json({ error: 'Unknown property.' }, 404, cors)

        const rows = await env.DB.prepare(
          `SELECT id, property_id, visit_id, category, width, height, bytes,
                  captured_lat, captured_lng, created_at
             FROM photos WHERE property_id = ?1 AND client_id = ?2
            ORDER BY created_at`,
        )
          .bind(propertyId, user.clientId)
          .all()

        return json(
          {
            photos: (rows.results as Record<string, unknown>[]).map((r) => ({
              id: r.id,
              propertyId: r.property_id,
              visitId: r.visit_id ?? undefined,
              category: r.category,
              width: r.width ?? undefined,
              height: r.height ?? undefined,
              bytes: r.bytes ?? undefined,
              capturedAt:
                r.captured_lat == null || r.captured_lng == null
                  ? undefined
                  : { lat: r.captured_lat, lng: r.captured_lng },
              createdAt: r.created_at,
            })),
          },
          200,
          cors,
        )
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
      // They can act on a reference — it turns "it broke" into a log query.
      logUnhandled(ctx, err)
      noteFailure()
      return new Response(
        JSON.stringify({ error: 'Something went wrong.', reference: ctx.id }),
        {
          status: 500,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            ...traceHeaders(ctx),
            ...cors,
          },
        },
      )
    }
  },
} satisfies ExportedHandler<Env>
