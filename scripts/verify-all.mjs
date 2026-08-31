import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Run every gate, and be honest about why one failed.
 *
 * There was no runner before this: the suite was a bash loop retyped each time,
 * which is fine right up until the thing that goes wrong is not a gate. Two
 * failure modes cost a full run each on the day this was written, and both are
 * what the script is shaped around.
 *
 * **A dead preview server looks like broken code.** When `vite preview` stopped,
 * 28 browser gates failed with ERR_CONNECTION_REFUSED and the summary read as 28
 * bugs. Every pure-Node gate passed, which was the only clue. So this checks the
 * server is answering before each gate and, if it stops, says *that* and stops —
 * rather than producing a list of failures that are all the same failure.
 *
 * **A failed build leaves the last one on disk.** `npm run build` is
 * `tsc -b && vite build`, so a type error means Vite never runs and `dist/` still
 * holds the previous bundle. Browser gates then test code that is not the code
 * you just wrote, and pass. So the build runs first here and a failure aborts
 * everything, loudly, instead of being scrolled past.
 *
 * Not CI. Nothing schedules this, nothing triggers it on push, and it bills
 * nobody — it is the by-hand suite with the two ways of fooling yourself
 * removed.
 *
 *   npm run verify:all              every gate
 *   npm run verify:all -- theme     only gates whose name contains "theme"
 *   npm run verify:all -- --bail    stop at the first failing gate
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const args = process.argv.slice(2)
const bail = args.includes('--bail')
const filters = args.filter((a) => !a.startsWith('--'))

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const gates = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith('verify:') && k !== 'verify:all')
  .filter((k) => filters.length === 0 || filters.some((f) => k.includes(f)))
  .sort()

if (gates.length === 0) {
  console.error(`No gates matched ${filters.join(', ')}.`)
  process.exit(1)
}

/** Run a command, returning its exit code and combined output. */
function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { shell: false })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

/** Is the preview server answering right now? */
async function serverUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}

const fail = (msg) => {
  console.error(`\n${msg}\n`)
  process.exit(1)
}

/* ---- 1. a fresh build, or nothing ------------------------------------- */
//
// Before anything else, because every browser gate below reads `dist/` and a
// stale one is indistinguishable from a passing one.
process.stdout.write('building… ')
const built = await run('npm', ['run', 'build'])
if (built.code !== 0) {
  console.log('FAILED')
  fail(
    [
      'The build failed, so no gate was run.',
      '',
      'This matters more than it looks: `npm run build` is `tsc -b && vite build`,',
      'so a type error means Vite never ran and dist/ still holds the previous',
      'bundle. Running the browser gates now would test the last build and pass.',
      '',
      built.out.split('\n').filter((l) => l.trim()).slice(-15).join('\n'),
    ].join('\n'),
  )
}
console.log('ok')

/* ---- 2. a preview server, started here if there isn't one ------------- */
let preview = null
if (await serverUp()) {
  console.log(`using the preview server already on ${BASE}`)
} else {
  process.stdout.write(`starting a preview server on ${BASE}… `)
  preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--host', '127.0.0.1'], {
    stdio: 'ignore',
  })
  const deadline = Date.now() + 30_000
  let up = false
  while (Date.now() < deadline) {
    if (await serverUp()) {
      up = true
      break
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  if (!up) {
    console.log('FAILED')
    preview.kill()
    fail(`No preview server came up on ${BASE} within 30s, so no gate was run.`)
  }
  console.log('ok')
}

const stopPreview = () => {
  // Only ours. A server someone else started stays up — they are probably using it.
  if (preview) preview.kill()
}
process.on('exit', stopPreview)
process.on('SIGINT', () => {
  stopPreview()
  process.exit(130)
})

/* ---- 3. the gates ----------------------------------------------------- */
console.log(`\n${gates.length} gate${gates.length === 1 ? '' : 's'}\n`)

const results = []
const started = Date.now()

for (const gate of gates) {
  /*
    Checked before every gate, not once at the start. The server dying midway is
    the case this exists for, and it is the one a single up-front check misses.
  */
  if (!(await serverUp())) {
    console.log('')
    fail(
      [
        `The preview server on ${BASE} stopped answering before ${gate}.`,
        '',
        `${results.filter((r) => r.ok).length} gate(s) had passed. The rest were not run —`,
        'every browser gate would have failed with ERR_CONNECTION_REFUSED, which',
        'reads as broken code and is not.',
        '',
        'Restart it and run again:  npm run preview',
      ].join('\n'),
    )
  }

  const t0 = Date.now()
  const { code, out } = await run('npm', ['run', gate])
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const ok = code === 0
  results.push({ gate, ok, out, secs })

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${gate.padEnd(24)} ${secs.padStart(6)}s`)
  if (!ok) {
    // The gate's own failing lines, indented — enough to act on without
    // re-running it to find out what broke.
    const lines = out.split('\n').filter((l) => /^FAIL|Error|never appeared/.test(l.trim()))
    for (const l of lines.slice(0, 8)) console.log(`        ${l.trim()}`)
    if (bail) break
  }
}

/* ---- 4. what happened ------------------------------------------------- */
const failed = results.filter((r) => !r.ok)
const mins = ((Date.now() - started) / 60000).toFixed(1)

console.log(`\n${results.length - failed.length}/${results.length} passed in ${mins} min`)

if (failed.length) {
  console.log(`\nfailing: ${failed.map((r) => r.gate).join(', ')}`)
  process.exit(1)
}
console.log('every gate passed')
