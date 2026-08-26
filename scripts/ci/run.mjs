import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverGates, shardOf } from './gates.mjs'

/**
 * Run a set of gates and report what happened.
 *
 * Two properties this has that a shell loop in a workflow file does not, and
 * both of them are the difference between CI that helps and CI that lies:
 *
 * **It keeps going.** A failing gate does not stop the rest. One run should say
 * "these four are broken", not "the first one is broken, try again in eleven
 * minutes to find out about the second".
 *
 * **It refuses an empty run.** A shard that matches nothing exits non-zero
 * rather than passing. Green because nothing ran is the most dangerous result
 * CI can produce, and it is exactly what a typo in a shard index yields.
 *
 * Usage:
 *   node scripts/ci/run.mjs --pure
 *   node scripts/ci/run.mjs --browser --shard 0 --of 4
 *   node scripts/ci/run.mjs --list
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const { browser, pure, broken } = discoverGates()

if (broken.length) {
  // Never a warning. An npm script pointing at a file that is not there is a
  // gate that silently stopped existing.
  for (const b of broken) console.error(`BROKEN  ${b.name} -> ${b.command}`)
  console.error(`\n${broken.length} gate(s) name a script file that does not exist`)
  process.exit(1)
}

if (flag('list')) {
  console.log(JSON.stringify({ browser, pure }, null, 2))
  process.exit(0)
}

const total = Number(value('of', 1))
const index = Number(value('shard', 0))
const pool = flag('pure') ? pure : flag('browser') ? browser : [...pure, ...browser]
const chosen = flag('browser') || flag('pure') ? shardOf(pool, index, total) : pool

if (chosen.length === 0) {
  console.error(
    `No gates selected (pool=${pool.length}, shard ${index} of ${total}). ` +
      `Refusing to report success for a run that did nothing.`,
  )
  process.exit(1)
}

console.log(`Running ${chosen.length} gate(s): ${chosen.join(', ')}\n`)

const failed = []
for (const name of chosen) {
  const started = Date.now()
  console.log(`::group::${name}`)
  const res = spawnSync('npm', ['run', '--silent', name], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  console.log('::endgroup::')
  const secs = ((Date.now() - started) / 1000).toFixed(0)
  if (res.status === 0) {
    console.log(`PASS  ${name}  (${secs}s)`)
  } else {
    console.log(`FAIL  ${name}  (${secs}s, exit ${res.status})`)
    failed.push(name)
  }
}

console.log(`\n${chosen.length - failed.length}/${chosen.length} passed`)
if (failed.length) console.log(`failed: ${failed.join(', ')}`)
process.exit(failed.length ? 1 : 0)
