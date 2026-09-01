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
  "/api/integrations/ghl/drain|POST": { how: 'inline', guard: 'canManageIntegrations' },
  "/api/integrations/ghl/calendar|PUT": { how: 'inline', guard: 'canManageIntegrations' },
  "/api/integrations/ghl/webhook|POST": { how: 'inline', guard: 'canManageIntegrations' },
  /*
    Erasure. The one destructive action in the product with no undo, and the
    permission is deliberately narrower than importing — `canErase` is checked
    inside `eraseProperty` rather than at the route, so the guard travels with
    the function wherever it is called from.
  */
  "/api/leads/erase|DELETE": { how: 'delegate', fn: 'eraseProperty', file: 'erase.ts' },
  "/api/integrations/ghl/calendar|PUT": { how: 'inline', guard: 'canManageIntegrations' },
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

/**
 * Route families matched with `startsWith` rather than an equality check.
 *
 * These were the hole in the first version of this gate. It matched
 * `path === '/api/...'` literals only, printed "every API route has decided who
 * may call it", and had never looked at /api/users/:id/* — the six most
 * privileged operations in the product: set a password, mint a reset link,
 * change a role, deactivate, delete. A gate whose claim is broader than its
 * coverage is worse than no gate, because it answers the question people would
 * otherwise go and check by hand.
 */
const FAMILIES = {
  '/api/users/': {
    // Every action resolves its target through one `guard`, which is checked
    // separately below. Listing them individually so a new action added to the
    // subtree has to be added here too.
    actions: ['footprint', 'password', 'reset-link', 'role', 'active', ''],
    file: 'users.ts',
    fns: {
      footprint: 'footprint',
      password: 'setPassword',
      'reset-link': 'createResetLink',
      role: 'setRole',
      active: 'setActive',
      '': 'deleteUser',
    },
  },
  // Scoped by `client_id` in the query itself, so one company's device cannot
  // fetch or overwrite another's photo by guessing an id.
  '/api/photos/': { match: "path.startsWith('/api/photos/", scopedBy: 'client_id = ?2' },
}

/**
 * And routes matched by a regular expression, which is a third style again.
 *
 * The first version of this gate knew about equality checks. The second learned
 * about `startsWith`. Both times the thing it had never looked at was the thing
 * worth looking at. `/api/properties/:id/photos` is matched with a regex, so it
 * was invisible to both — hence enumerating every matcher style below rather
 * than adding a third special case and hoping that is the last one.
 */
const REGEX_ROUTES = {
  '/^\\/api\\/properties\\/[^/]+\\/photos$/': {
    match: "/^\\/api\\/properties\\/[^/]+\\/photos$/.test(path)",
    scopedBy: 'client_id = ?2',
  },
  /*
    The inbound GoHighLevel webhook. Public by necessity — GoHighLevel has no
    Allstar login — so the URL is the credential, and the only thing worth
    asserting is that the URL, and nothing else, decides whose data it touches.
  */
  '/^\\/api\\/webhooks\\/ghl\\/([a-f0-9]{64})$/': {
    match: "/^\\/api\\/webhooks\\/ghl\\/([a-f0-9]{64})$/.exec(path)",
    credential: 'clientForSecret',
  },
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

/* ---- 3. every matcher style, so nothing can hide in a fourth ---------- */
{
  const byStartsWith = [
    ...new Set([...src.matchAll(/path\.startsWith\('(\/api\/[^']*)'\)/g)].map((m) => m[1])),
  ]
  /*
    Captured from `.test(path)` backwards, not by trying to describe a regex
    with a regex.

    The clever version matched nothing, so `byRegex` was empty and "every regex
    route is declared" passed on an empty array — the exact vacuous pass this
    gate exists to prevent, in the part of the gate added to close the previous
    vacuous pass. The give-away was the enumeration message listing two families
    and no regex route while a regex route plainly exists.
  */
  /*
    Both `.test(path)` and `.exec(path)`. This captured only `.test` until the
    next regex route added to the router used `.exec` — a public webhook sitting
    *above* the authentication boundary, the most security-sensitive shape a
    route can have, and it was invisible here.

    A matcher style this does not enumerate is a route the gate silently exempts,
    which is worse than no gate at all: the passing line claims every route was
    examined.
  */
  const byRegex = [
    ...new Set(
      [...src.matchAll(/(\/\^[^\n]*?\/)\.(?:test|exec)\(path\)/g)].map((m) => m[1]),
    ),
  ]
  ok(
    byStartsWith.length + byRegex.length > 0,
    `dynamic routes were found (${[...byStartsWith, ...byRegex].join(', ')})`,
  )

  const undeclaredPrefix = byStartsWith.filter((f) => !FAMILIES[f])
  ok(
    undeclaredPrefix.length === 0,
    `every startsWith family is declared${undeclaredPrefix.length ? ` — undeclared: ${undeclaredPrefix.join(', ')}` : ''}`,
  )

  const undeclaredRegex = byRegex.filter((r) => !REGEX_ROUTES[r])
  ok(
    undeclaredRegex.length === 0,
    `every regex route is declared${undeclaredRegex.length ? ` — undeclared: ${undeclaredRegex.join(', ')}` : ''}`,
  )

  /*
    Declaring a route is not checking it, and a declaration field nothing reads
    is worse than no field: it reads as a guarantee.

    `credential` is tied to the URL structurally rather than by forbidding words.
    The first attempt asserted the lookup function was called, and separately
    that the text `body.` did not appear nearby. Both passed on a deliberate
    sabotage reading the tenant from `clientForSecret(env, String(body0.locationId))`
    — the variable was named `body0`, so the blocklist missed it, and the
    positive check was satisfied merely by the function being called at all. The
    gate printed "resolves the tenant through clientForSecret, not from the
    payload" over code doing exactly the opposite.

    So: find the variable the path match is bound to, and require that this
    variable's capture is what the tenant is looked up by. Nothing else can
    satisfy that, and it does not depend on guessing what a mistake would be
    named.
  */
  for (const [pattern, decl] of Object.entries(REGEX_ROUTES)) {
    const at = src.indexOf(decl.match)
    ok(at >= 0, `the matcher for ${pattern} is present exactly as declared`)
    if (at < 0) continue
    const region = src.slice(Math.max(0, at - 200), at + 1600)

    if (decl.scopedBy) {
      ok(region.includes(decl.scopedBy), `${pattern} scopes its query by ${decl.scopedBy}`)
    }

    if (decl.credential) {
      const escaped = decl.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const bind = new RegExp(`const\\s+([A-Za-z0-9_]+)\\s*=\\s*${escaped}`).exec(region)
      ok(!!bind, `${pattern} binds its path match to a variable`)
      if (bind) {
        ok(
          new RegExp(`${decl.credential}\\(\\s*env\\s*,\\s*${bind[1]}\\[`).test(region),
          `${pattern} looks its tenant up from the URL capture, via ${decl.credential}(env, ${bind[1]}[…])`,
        )
      }
    }
  }

  // The users subtree: every action in the source is declared, and every
  // declared one still resolves through the shared guard.
  const usersAt = src.indexOf("path.startsWith('/api/users/')")
  if (usersAt < 0) throw new Error('the /api/users/ subtree moved — update this gate')
  const subtree = src.slice(usersAt, usersAt + 2600)
  const inSource = [...subtree.matchAll(/action === '([^']*)'/g)].map((m) => m[1])
  if (/!action && req\.method === 'DELETE'/.test(subtree)) inSource.push('')

  const declaredActions = FAMILIES['/api/users/'].actions
  const missing = inSource.filter((a) => !declaredActions.includes(a))
  ok(
    missing.length === 0,
    `every /api/users/ action is declared${missing.length ? ` — missing: ${missing.map((a) => a || 'DELETE').join(', ')}` : ''}`,
  )

  const usersSrc = readFileSync(new URL('../api/src/users.ts', import.meta.url), 'utf8')
  for (const action of declaredActions) {
    const fn = FAMILIES['/api/users/'].fns[action]
    const at = usersSrc.indexOf(`export async function ${fn}`)
    if (at < 0) throw new Error(`${fn} is gone from users.ts — update this gate`)
    ok(
      /guard\(a,/.test(usersSrc.slice(at, at + 700)),
      `/api/users/:id/${action || '(DELETE)'} resolves its target through guard`,
    )
  }

  /*
    Tenant scoping on the routes whose whole authorization is the tenant check.

    Anchored on the matcher text so a missing block fails loudly instead of
    slicing from index -1, which is what happened when a family was declared
    that the source did not actually match that way — the check then read the
    wrong 2,600 characters and reported a scoping failure that was really a
    bookkeeping error in the gate.
  */
  for (const decl of [...Object.values(FAMILIES), ...Object.values(REGEX_ROUTES)]) {
    if (!decl.scopedBy || !decl.match) continue
    const at = src.indexOf(decl.match)
    if (at < 0) throw new Error(`the matcher \`${decl.match}\` is gone — update this gate`)
    ok(
      src.slice(at, at + 2600).includes(decl.scopedBy),
      `${decl.match.slice(0, 44)}… scopes its query by ${decl.scopedBy}`,
    )
  }
}

/* ---- 4. the one guard the whole subtree rests on ---------------------- */
{
  /*
    Six operations share it, so weakening it weakens all six at once — which
    makes it the highest-leverage thing on the server and worth asserting
    property by property rather than trusting that it is "the guard".
  */
  const usersSrc = readFileSync(new URL('../api/src/users.ts', import.meta.url), 'utf8')
  const at = usersSrc.indexOf('async function guard(')
  if (at < 0) throw new Error('users.ts no longer has a shared guard — update this gate')
  const g = usersSrc.slice(at, at + 2200)

  ok(/!canInvite\(actor\)/.test(g), 'guard requires canInvite unless acting on your own account')
  ok(
    /WHERE id = \?1 AND client_id = \?2/.test(g),
    'and loads the target scoped to the caller’s own company',
  )
  ok(
    /actor\.role !== 'super_admin'/.test(g),
    'and refuses to let a lesser role act on a super admin',
  )
  ok(
    /fail\('No such person on this team\.', 404\)/.test(g),
    'and answers 404 for another company’s user, so existence does not leak',
  )
}

/* ---- 5. the diagnostics cannot default open ---------------------------- */
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
