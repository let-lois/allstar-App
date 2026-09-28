import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Run every API-side test, in one command.
 *
 * There were seventeen of these and nothing that ran them. The browser suite has
 * had a runner for a while — `npm run verify:all`, one command, forty-five gates
 * — and the API side had none, so exercising it meant typing seventeen names and
 * knowing which ones need a server, which need an administrator to exist first,
 * and which cannot run at all without an argument. That knowledge lived in one
 * person's head, which is the same as it not existing, and it is why the newest
 * and most security-sensitive tests in the codebase — the CRM push, the CRM
 * webhook, and erasure — were written, proved, and then left somewhere nobody
 * would run them.
 *
 * ## Why this is not the same runner as the browser one
 *
 * These tests are not uniform, and pretending they are is how a runner reports
 * failures that are really setup problems. Four kinds:
 *
 *   **pure**    no server at all. Parsing, arithmetic, structural checks.
 *               Fast, so they go first: a broken build should not cost four
 *               minutes of Worker startup before anybody hears about it.
 *
 *   **hosted**  spins up its own Worker on its own port with its own database.
 *               Run strictly serially — two of these at once collide on
 *               `.wrangler` state and the second silently tests the first one's
 *               data.
 *
 *   **shared**  expects a Worker already listening on 8787, and an administrator
 *               to exist. `smoke:onboarding` is what creates that administrator,
 *               so these are ordered rather than merely grouped: onboarding
 *               first, or the rest fail authenticating and it reads as five
 *               bugs.
 *
 *   **manual**  cannot run unattended. `verify:restore` needs a backup file, and
 *               a backup is a thing somebody makes on purpose. Reported as
 *               skipped *with the reason*, never silently omitted — a suite that
 *               quietly runs sixteen of seventeen is a suite that lies about its
 *               own coverage.
 *
 * ## The failure this is shaped around
 *
 * The browser runner learned it the hard way: when its preview server died, 28
 * gates failed with connection errors and the summary read as 28 bugs. The same
 * trap is worse here, because the shared Worker takes a minute to come up and
 * every test behind it fails identically. So the server is checked before each
 * shared test, and if it has gone the run says *that* and stops, rather than
 * producing a list of failures that are all one failure.
 *
 *   npm run smoke:all            everything
 *   npm run smoke:all -- crm     only tests whose name contains "crm"
 *   npm run smoke:all -- --bail  stop at the first failure
 *   npm run smoke:all -- --fast  the pure checks only, no Workers
 *
 * It is slow — most of the time is Workers starting — so it is a thing you run
 * before a release, not between edits. `--fast` exists for between edits.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const run = promisify(execFile)

const SHARED_PORT = 8787
const SHARED_STATE = resolve(api, '.wrangler/smoke-all-state')
const SETUP_TOKEN = 'smoke-all-setup-token'
/*
  Not an arbitrary choice: these are the credentials `smoke-onboarding.mjs`
  creates through the real /setup flow, and every shared test authenticates as
  them. Getting the password wrong here does not look like a wrong password — it
  looks like three unrelated tests failing in under half a second, which is
  exactly what happened the first time this ran. If onboarding's constants
  change, these follow.
*/
const ADMIN = { email: 'owner@example.com', password: 'correct-horse-battery' }

/**
 * Every test, and what it needs.
 *
 * Written out rather than derived from package.json, because the whole point is
 * the part package.json cannot say: which need a server, which must come first,
 * and which cannot run here at all. A new test that is not added to this list is
 * caught below — a runner that silently ignores tests it has not been told about
 * is the failure this replaces.
 */
const TESTS = [
  // --- pure: no server, fast --------------------------------------------
  { script: 'verify:geocode', kind: 'pure' },
  { script: 'verify:geocode:fallback', kind: 'pure' },
  { script: 'verify:directions', kind: 'pure' },
  { script: 'verify:territories', kind: 'pure' },
  { script: 'verify:territory-reps', kind: 'pure' },
  { script: 'verify:addresses', kind: 'pure' },
  { script: 'verify:onboarding-status', kind: 'pure' },

  // --- shared: one Worker on 8787, and order matters --------------------
  { script: 'smoke:onboarding', kind: 'shared', first: true },
  { script: 'smoke', kind: 'shared' },
  { script: 'smoke:users', kind: 'shared' },
  { script: 'smoke:import', kind: 'shared' },
  { script: 'smoke:migrate', kind: 'shared' },
  { script: 'smoke:team-model', kind: 'shared' },
  { script: 'smoke:observe', kind: 'shared' },
  { script: 'smoke:cors', kind: 'shared' },

  // --- hosted: brings its own Worker, its own port, its own database ----
  { script: 'smoke:photos', kind: 'hosted', port: 8799 },
  { script: 'smoke:integrations', kind: 'hosted', port: 8801 },
  { script: 'smoke:money', kind: 'hosted', port: 8803 },
  { script: 'smoke:daybreak', kind: 'hosted', port: 8804 },
  { script: 'smoke:crm-push', kind: 'hosted', port: 8811 },
  { script: 'smoke:crm-inbound', kind: 'hosted', port: 8821 },
  { script: 'smoke:erase', kind: 'hosted', port: 8831 },
  { script: 'smoke:stale', kind: 'hosted', port: 8834 },
  { script: 'smoke:backup', kind: 'hosted', port: 8817 },
  { script: 'smoke:deadkey', kind: 'hosted', port: 8841 },
  { script: 'smoke:lists', kind: 'hosted', port: 8851 },
  { script: 'smoke:territory-reps', kind: 'hosted', port: 8852 },
  { script: 'smoke:territory-leads', kind: 'hosted', port: 8853 },
  { script: 'smoke:lead-edit', kind: 'hosted', port: 8855 },
  { script: 'smoke:quote-sent', kind: 'hosted', port: 8856 },
  { script: 'smoke:onboarding-schema', kind: 'hosted', port: 8861 },
  { script: 'smoke:onboarding-flow', kind: 'hosted', port: 8871 },
  { script: 'smoke:mail', kind: 'hosted', port: 8881 },
  { script: 'smoke:onboarding-steps', kind: 'hosted', port: 8891 },
  { script: 'smoke:export', kind: 'hosted', port: 8901 },
  { script: 'smoke:tiles', kind: 'hosted', port: 8911 },

  // --- manual -----------------------------------------------------------
  {
    script: 'verify:restore',
    kind: 'manual',
    why:
      'needs a backup file: npm run backup, then npm run verify:restore <file>. ' +
      'smoke:backup already runs this drill against what the nightly cron writes, ' +
      'so what stays manual is the one thing it cannot cover: a real dump of real ' +
      'production, opened with the real key.',
  },
]

const args = process.argv.slice(2)
const bail = args.includes('--bail')
const fastOnly = args.includes('--fast')
const filters = args.filter((a) => !a.startsWith('--'))

/* --- the list is honest about itself ------------------------------------ */
//
// A test in package.json that nobody added here would never run and nobody
// would know. Checked rather than trusted, because that is precisely the
// failure this file exists to end.
{
  const pkg = JSON.parse(readFileSync(resolve(api, 'package.json'), 'utf8'))
  const inPkg = Object.keys(pkg.scripts).filter(
    (k) => (k === 'smoke' || k.startsWith('smoke:') || k.startsWith('verify:')) && k !== 'smoke:all',
  )
  const known = new Set(TESTS.map((t) => t.script))
  const missing = inPkg.filter((k) => !known.has(k))
  if (missing.length) {
    console.error(
      `\nThese tests exist but this runner does not know about them:\n` +
        missing.map((m) => `  ${m}`).join('\n') +
        `\n\nAdd them to TESTS in scripts/smoke-all.mjs, with the kind of setup they need.\n` +
        `A runner that silently skips tests is worse than no runner.\n`,
    )
    process.exit(1)
  }
  const stale = [...known].filter((k) => !inPkg.includes(k))
  if (stale.length) {
    console.error(`\nThis runner lists tests that no longer exist: ${stale.join(', ')}\n`)
    process.exit(1)
  }
}

let chosen = TESTS.filter(
  (t) => filters.length === 0 || filters.some((f) => t.script.includes(f)),
).filter((t) => !fastOnly || t.kind === 'pure')

/*
  A shared test cannot run alone.

  `smoke:onboarding` is what creates the administrator the others sign in as, so
  filtering to `smoke:users` and nothing else would start a clean Worker with no
  accounts on it and report an authentication failure — a filter producing a
  failure that has nothing to do with the code being filtered for. Pulled in
  automatically, and said out loud so nobody wonders why an extra test ran.
*/
if (chosen.some((t) => t.kind === 'shared')) {
  const opener = TESTS.find((t) => t.kind === 'shared' && t.first)
  if (opener && !chosen.includes(opener)) {
    console.log(`(adding ${opener.script} — it creates the administrator the shared tests sign in as)`)
    chosen = [opener, ...chosen]
  }
}

if (chosen.length === 0) {
  console.error(`Nothing matched ${filters.join(', ')}.`)
  process.exit(1)
}

/** Is anything listening there? Used to keep hosted tests from colliding. */
async function portBusy(port) {
  try {
    const { stdout } = await run('ss', ['-ltn', `sport = :${port}`])
    return /LISTEN/.test(stdout)
  } catch {
    return false
  }
}

async function freePort(port) {
  try {
    const { stdout } = await run('ss', ['-ltnp', `sport = :${port}`])
    const pids = [...stdout.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
    for (const pid of new Set(pids)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening, or ss unavailable */
  }
  for (let i = 0; i < 20; i++) {
    if (!(await portBusy(port))) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function npmRun(script, env = {}) {
  return new Promise((done) => {
    const child = spawn('npm', ['run', script], {
      cwd: api,
      shell: false,
      env: { ...process.env, ...env },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => done({ code: code ?? 1, out }))
  })
}

/* --- the shared Worker --------------------------------------------------- */

let sharedWorker = null

async function startShared() {
  rmSync(SHARED_STATE, { recursive: true, force: true })
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const cfgPath = resolve(api, '.wrangler/smoke-all.toml')
  mkdirSync(dirname(cfgPath), { recursive: true })
  writeFileSync(cfgPath, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))

  // The baseline an operator applies once. Migrations bring an existing database
  // forward; they are not a substitute for it, and skipping this tests a Worker
  // running against nothing.
  await new Promise((ok2, no) => {
    const p = spawn(
      resolve(api, 'node_modules/.bin/wrangler'),
      ['d1', 'execute', 'allstar-db', '--local', '--persist-to', SHARED_STATE,
       '--file', './schema.sql', '-c', cfgPath, '-y'],
      { cwd: api, stdio: 'ignore' },
    )
    p.on('exit', (c) => (c === 0 ? ok2() : no(new Error(`schema apply exited ${c}`))))
  })

  sharedWorker = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['dev', '-c', cfgPath, '--port', String(SHARED_PORT), '--ip', '127.0.0.1',
     '--local-protocol', 'http', '--persist-to', SHARED_STATE, '--log-level', 'warn',
     '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
     '--var', 'SESSION_PEPPER:smoke-all-pepper',
     '--var', 'INTEGRATION_KEY:smoke-all-key-do-not-reuse'],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  sharedWorker.stdout.on('data', () => {})
  sharedWorker.stderr.on('data', () => {})

  for (let i = 0; i < 90; i++) {
    if (await sharedUp()) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

async function sharedUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${SHARED_PORT}/api/health`, {
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function stopShared() {
  if (!sharedWorker) return
  try {
    process.kill(-sharedWorker.pid, 'SIGTERM')
  } catch {
    sharedWorker.kill('SIGTERM')
  }
  sharedWorker = null
  await freePort(SHARED_PORT)
  rmSync(SHARED_STATE, { recursive: true, force: true })
}

process.on('SIGINT', async () => {
  await stopShared()
  process.exit(130)
})

/* --- go ------------------------------------------------------------------ */

const started = Date.now()
const results = []
const width = Math.max(...chosen.map((t) => t.script.length)) + 2

console.log(`\n${chosen.length} API tests\n`)

const sharedEnv = {
  API_URL: `http://127.0.0.1:${SHARED_PORT}`,
  SETUP_TOKEN,
  ADMIN_EMAIL: ADMIN.email,
  ADMIN_PASSWORD: ADMIN.password,
}

// Ordered so a `first: true` shared test really does go first: it creates the
// administrator the others authenticate as.
const ordered = [
  ...chosen.filter((t) => t.kind === 'pure'),
  ...chosen.filter((t) => t.kind === 'shared' && t.first),
  ...chosen.filter((t) => t.kind === 'shared' && !t.first),
  ...chosen.filter((t) => t.kind === 'hosted'),
  ...chosen.filter((t) => t.kind === 'manual'),
]

let sharedNeeded = ordered.some((t) => t.kind === 'shared')
let sharedReady = false

for (const test of ordered) {
  if (test.kind === 'manual') {
    console.log(`SKIP  ${test.script.padEnd(width)}  ${test.why}`)
    results.push({ ...test, status: 'skipped' })
    continue
  }

  if (test.kind === 'shared' && !sharedReady) {
    process.stdout.write(`starting a Worker on :${SHARED_PORT} for the shared tests… `)
    await freePort(SHARED_PORT)
    sharedReady = await startShared()
    console.log(sharedReady ? 'ok\n' : 'FAILED\n')
    if (!sharedReady) {
      console.error(
        `The shared Worker never became healthy, so none of the tests that need it\n` +
          `can run. That is one failure, not ${ordered.filter((t) => t.kind === 'shared').length}.\n`,
      )
      results.push({ script: '(shared Worker)', status: 'blocked' })
      break
    }
  }

  /*
    Checked before every shared test, not once at the start. A Worker that dies
    half way turns every remaining test into an identical authentication failure,
    and a summary full of those sends somebody debugging the wrong thing.
  */
  if (test.kind === 'shared' && !(await sharedUp())) {
    console.error(`\nThe shared Worker stopped answering before ${test.script}. Stopping here.\n`)
    results.push({ script: test.script, status: 'blocked' })
    break
  }

  if (test.kind === 'hosted' && test.port) {
    // A Worker left behind by a crashed run would make this test exercise the
    // previous test's database, and pass.
    if (await portBusy(test.port)) {
      process.stdout.write(`freeing :${test.port}… `)
      const freed = await freePort(test.port)
      console.log(freed ? 'ok' : 'still busy')
    }
  }

  const at = Date.now()
  const { code, out } = await npmRun(test.script, test.kind === 'shared' ? sharedEnv : {})
  const secs = ((Date.now() - at) / 1000).toFixed(1)
  const passed = code === 0
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${test.script.padEnd(width)}${secs.padStart(7)}s`)
  results.push({ script: test.script, status: passed ? 'passed' : 'failed', out, secs })

  if (!passed && bail) break
}

await stopShared()

/* --- what happened ------------------------------------------------------- */

const failed = results.filter((r) => r.status === 'failed')
const blocked = results.filter((r) => r.status === 'blocked')
const skipped = results.filter((r) => r.status === 'skipped')
const passed = results.filter((r) => r.status === 'passed')
const mins = ((Date.now() - started) / 60000).toFixed(1)

console.log(`\n${passed.length}/${passed.length + failed.length} passed in ${mins} min`)
if (skipped.length) console.log(`${skipped.length} skipped and named above — not counted as passing`)

for (const f of failed) {
  console.log(`\n${'─'.repeat(70)}\n${f.script}\n${'─'.repeat(70)}`)
  // The tail, because these print their assertions as they go and the summary
  // at the bottom is what says which one broke.
  console.log(f.out.trimEnd().split('\n').slice(-25).join('\n'))
}

if (blocked.length) {
  console.log(`\nStopped early: ${blocked.map((b) => b.script).join(', ')} could not run.`)
  process.exit(1)
}
if (failed.length) process.exit(1)
console.log('\nevery API test passed')
