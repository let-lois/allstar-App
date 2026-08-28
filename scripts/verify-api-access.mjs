import { readFileSync } from 'node:fs'

/**
 * Every API route has to have decided who may call it.
 *
 * This exists because of what the console taught: a rule stated in one place
 * and enforced in another is a rule that eventually is not enforced at all. The
 * console hid links a role should not have and never locked the doors, and the
 * only reason that was harmless is that the server refused those requests. The
 * server is the boundary that actually protects anything — so it should not be
 * the layer nobody has read end to end.
 *
 * Reading it end to end found one: `/api/selftest/geocode` sat in front of
 * authentication, accepted an arbitrary address, and handed it to a paid
 * geocoder. Anyone with curl could spend the deployment's Google quota in a
 * loop, at list price. CORS is no help — it is a browser rule and a script
 * ignores it.
 *
 * The check is a table rather than a heuristic. Each route names how it is
 * guarded, and a route in the source that is not in the table fails: the point
 * is not that every route is locked — several are deliberately open — but that
 * somebody decided, and wrote the decision down where the next person can see
 * it. A forgotten route and a deliberately public one look identical in code.
 */

const src = readFileSync(new URL('../api/src/index.ts', import.meta.url), 'utf8')

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/**
 * How each route decides.
 *
 *   public    deliberately unauthenticated, and safe to be
 *   token     unauthenticated by necessity, gated on SETUP_TOKEN — the
 *             diagnostics, which have to work when nobody can sign in
 *   session   any signed-in user, scoped to their own company by the handler
 *   inline    a can*() call inside the handler itself
 *   delegate  the named function performs the check
 */
const ROUTES = {
  "/api/selftest": { how: 'token' },
  "/api/selftest/geocode": { how: 'token' },
  // Presence and counts only — never a value, a prefix or a length. Public so a
  // deployment can be diagnosed when sign-in is the thing that is broken.
  "/api/health": { how: 'public' },
  "/api/auth/login|POST": { how: 'public' },
  "/api/auth/logout|POST": { how: 'public' },

  "/api/me": { how: 'session' },
  "/api/bootstrap|GET": { how: 'session' },
  // Any rep may ask for a walking line to a door. On the Worker because the
  // browser key cannot spend routing quota.
  "/api/directions|POST": { how: 'session' },
  // The rep's own sync. Every statement in applyMutations binds user.clientId,
  // which is what keeps one company's phone out of another's data.
  "/api/mutations|POST": { how: 'session' },
  // The field app needs the company's outcome labels to draw its buttons.
  "/api/settings|GET": { how: 'session' },

  "/api/invites|POST": { how: 'inline', guard: 'canInvite' },
  "/api/users|GET": { how: 'inline', guard: 'canImport' },
  "/api/audit|GET": { how: 'inline', guard: 'canInvite' },
  "/api/import/geocode|POST": { how: 'inline', guard: 'canImport' },
  "/api/import/properties|POST": { how: 'inline', guard: 'canImport' },
  "/api/integrations|GET": { how: 'inline', guard: 'canManageIntegrations' },
  "/api/integrations/ghl|POST": { how: 'inline', guard: 'canManageIntegrations' },
  "/api/integrations/ghl|DELETE": { how: 'inline', guard: 'canManageIntegrations' },
  "/api/geocoders|GET": { how: 'inline', guard: 'canManageIntegrations' },
  "/api/geocoders/key|POST": { how: 'inline', guard: 'canManageIntegrations' },
  "/api/geocoders/key|DELETE": { how: 'inline', guard: 'canManageIntegrations' },
  "/api/geocoders/active|POST": { how: 'inline', guard: 'canManageIntegrations' },

  "/api/settings|POST": { how: 'delegate', fn: 'writeSettings', file: 'settings.ts' },
  "/api/settings/timezone|POST": { how: 'delegate', fn: 'writeTimezone', file: 'settings.ts' },
  "/api/properties/assign|POST": { how: 'delegate', fn: 'assignProperties', file: 'assign.ts' },
  "/api/territories/assign|POST": { how: 'delegate', fn: 'assignTerritory', file: 'assign.ts' },
  "/api/territories|POST": { how: 'delegate', fn: 'createTerritory', file: 'territories.ts' },
}

/* ---- what the source actually has ------------------------------------- */

const lines = src.split('\n')
const authLine = lines.findIndex((l) => /const user = await requireUser\(/.test(l))
if (authLine < 0) throw new Error('could not find the authentication boundary — update this gate')

const found = []
lines.forEach((line, i) => {
  const m = line.match(/path === '(\/api[^']*)'(?:\s*&&\s*req\.method === '([A-Z]+)')?/)
  if (m) found.push({ path: m[1], method: m[2], line: i, key: m[2] ? `${m[1]}|${m[2]}` : m[1] })
})

ok(found.length > 0, `the router was parsed (${found.length} routes)`)

/* ---- 1. nothing undeclared, nothing stale ------------------------------ */
{
  const declared = new Set(Object.keys(ROUTES))
  const actual = new Set(found.map((r) => r.key))

  const undeclared = [...actual].filter((k) => !declared.has(k))
  ok(
    undeclared.length === 0,
    `every route names how it is guarded${undeclared.length ? ` — undeclared: ${undeclared.join(', ')}` : ''}`,
  )

  const stale = [...declared].filter((k) => !actual.has(k))
  ok(
    stale.length === 0,
    `and nothing is declared that no longer exists${stale.length ? ` — stale: ${stale.join(', ')}` : ''}`,
  )
}

/* ---- 2. each route is guarded the way it says -------------------------- */
for (const route of found) {
  const decl = ROUTES[route.key]
  if (!decl) continue // already reported above

  // The handler body: from this route to whichever route comes next.
  const next = found.filter((r) => r.line > route.line).sort((a, b) => a.line - b.line)[0]
  const body = lines.slice(route.line, next ? next.line : route.line + 40).join('\n')

  switch (decl.how) {
    case 'public':
      ok(route.line < authLine, `${route.key} is public and sits before authentication`)
      break

    case 'token':
      // The one that was wrong. It must refuse before it does anything, and it
      // has to be checked here rather than assumed from being "a diagnostic".
      ok(
        /diagnosticsAllowed\(req, env\)/.test(body),
        `${route.key} requires the setup token before it spends anything`,
      )
      break

    case 'session':
      ok(route.line > authLine, `${route.key} is behind authentication`)
      break

    case 'inline':
      ok(
        new RegExp(`!${decl.guard}\\(user\\)`).test(body),
        `${route.key} checks ${decl.guard} in the handler`,
      )
      ok(route.line > authLine, `and ${route.key} is behind authentication`)
      break

    case 'delegate': {
      // Reading the delegate rather than trusting the name: a function that
      // takes `user` looks guarded from the call site whether or not it is.
      const fnSrc = readFileSync(new URL(`../api/src/${decl.file}`, import.meta.url), 'utf8')
      const at = fnSrc.indexOf(`export async function ${decl.fn}`)
      if (at < 0) throw new Error(`${decl.fn} is gone from ${decl.file} — update this gate`)
      const fnBody = fnSrc.slice(at, at + 1200)
      ok(
        /can[A-Z][a-zA-Z]*\(actor\)|actor\.role/.test(fnBody),
        `${route.key} delegates to ${decl.fn}, which checks the role itself`,
      )
      ok(route.line > authLine, `and ${route.key} is behind authentication`)
      break
    }
  }
}

/* ---- 3. the diagnostics cannot default open ---------------------------- */
{
  const at = src.indexOf('function diagnosticsAllowed')
  ok(at > 0, 'the diagnostics guard exists')
  const fn = src.slice(at, at + 900)
  ok(
    /if \(!expected\) return false/.test(fn),
    'and a deployment with no setup token refuses rather than defaulting open',
  )
}

if (fails.length) {
  console.log(`\n${fails.length} API access check(s) failed`)
  process.exit(1)
}
console.log('\nevery API route has decided who may call it')
