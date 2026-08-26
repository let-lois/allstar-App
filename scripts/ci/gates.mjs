import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What the gates are, and which ones need a browser.
 *
 * Discovered rather than listed. A hand-maintained list of thirty-five entries
 * is a list somebody forgets to add to, and the failure is silent in the worst
 * possible way: CI goes green having quietly stopped running the gate somebody
 * just wrote. So the source of truth is `package.json` — anything named
 * `verify:*` is a gate, and a new one is picked up by existing.
 *
 * The browser/pure split is read from the file itself: importing `playwright`
 * means it needs Chromium and a server to point at. That is a fact about the
 * script rather than a convention it has to remember to follow.
 *
 * Gates whose script file cannot be found are reported rather than skipped. An
 * npm script pointing at a file that isn't there should fail the run, not
 * vanish from it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

/** `node scripts/verify-thing.mjs` → `scripts/verify-thing.mjs` */
function fileOf(command) {
  const m = /(?:^|\s)((?:scripts|api\/scripts)\/[\w.-]+\.mjs)/.exec(command)
  return m ? m[1] : null
}

export function discoverGates() {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const browser = []
  const pure = []
  const broken = []

  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith('verify:')) continue
    const file = fileOf(command)
    if (!file || !existsSync(resolve(root, file))) {
      broken.push({ name, command })
      continue
    }
    const source = readFileSync(resolve(root, file), 'utf8')
    ;(/from 'playwright'/.test(source) ? browser : pure).push(name)
  }

  return { browser, pure, broken }
}

/**
 * Deal `items` into `total` piles and hand back pile `index` (0-based).
 *
 * Round-robin rather than contiguous blocks. The gates are in package.json
 * order, which loosely groups related — and similarly slow — ones together, so
 * slicing into blocks would put most of the long ones in the same shard and the
 * job would take as long as the slowest pile. Dealing spreads them.
 */
export function shardOf(items, index, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`bad shard total: ${total}`)
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(`shard index ${index} out of range for ${total}`)
  }
  return items.filter((_, i) => i % total === index)
}
