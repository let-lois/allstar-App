import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every class the source names actually exists.
 *
 * Written after a rename left the sign-in button invisible. The button carried
 * `btn-3d`, whose entire appearance was a gradient; the rule was replaced by
 * `btn-fill` and that one reference was missed. Nothing failed — not the
 * typecheck, not the build, not a single browser gate — because a dangling class
 * name is valid HTML that styles nothing. What shipped was white text on a navy
 * background: the primary action on the first screen of the product, gone.
 *
 * The check works because Tailwind emits only the utilities it finds in the
 * source. So any static class token in a `className` that is absent from the
 * built stylesheet is either a typo or a reference to a rule that no longer
 * exists — there is no third explanation. That makes the *build output* the
 * oracle, which is why this runs against `dist` rather than parsing the config.
 *
 * No browser, no server. It is a text comparison, and it takes about a second.
 */

const CSS_DIR = 'dist/assets'
/*
  Two roots since the extraction: the app, and `packages/core`, which is where
  the platform-free half of the domain now lives. Scanning only `src` would
  have quietly stopped covering the moved files — and a gate that stops looking
  is worse than one that fails, because it still prints PASS.
*/
const SRC = ['src', 'packages/core/src']

/* --- what the stylesheet actually contains -------------------------------- */
const cssFiles = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'))
if (cssFiles.length === 0) {
  console.error('No built CSS found. Run `npm run build` first.')
  process.exit(1)
}
const css = cssFiles.map((f) => readFileSync(join(CSS_DIR, f), 'utf8')).join('\n')

/*
  Class selectors, unescaped. Tailwind writes `.text-\[13px\]` and
  `.hover\:bg-x`, so the backslashes come out before comparing — otherwise every
  arbitrary value and every variant reads as missing.
*/
const defined = new Set(
  [...css.matchAll(/\.((?:\\.|[^\s{}:,>+~[\]()"'#.])+)/g)].map((m) => m[1].replace(/\\/g, '')),
)

/* --- what the source asks for --------------------------------------------- */
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.tsx$/.test(e.name)) out.push(p)
  }
  return out
}

/*
  Only static text is checked. A class assembled at runtime from a variable
  cannot be resolved here, and guessing would produce noise — the tokens that
  matter are the ones written down, which is all of them in practice.
*/
const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\}|\{"([^"]*)"\})/g

/*
  Tailwind's marker classes carry no rules of their own — `group` and `peer` only
  exist so *other* selectors can reference them — so they never appear in the
  output and are not evidence of anything.
*/
const MARKERS = new Set(['group', 'peer'])

const missing = new Map()
let checked = 0

for (const file of SRC.flatMap(walk)) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(CLASS_ATTR)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
    // Template holes leave `${...}` behind; drop them and keep the literal parts.
    for (const token of raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (!token) continue
      checked += 1
      if (defined.has(token) || MARKERS.has(token)) continue
      if (!missing.has(token)) missing.set(token, new Set())
      missing.get(token).add(file)
    }
  }
}

console.log(`${checked} class references checked against ${defined.size} defined classes`)

if (missing.size === 0) {
  console.log('\n=== every class exists ===')
  process.exit(0)
}

for (const [token, files] of [...missing].sort()) {
  console.log(`FAIL  "${token}" is not in the built stylesheet — ${[...files].join(', ')}`)
}
console.log(`\n${missing.size} FAILED`)
process.exit(1)
