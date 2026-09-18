import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'

/**
 * The web app's images, as data URIs, for the shell bundle only.
 *
 * ## Why an image needs generating at all
 *
 * A DOM component's page is loaded from a local file, and Metro emits a *bare
 * relative* URL for an imported asset — `uri: "e10947….png"`, no directory. So
 * the file has to sit next to the HTML, and whether it does depends on which of
 * Expo's two export paths built it:
 *
 *   - `exportEmbedAsync.js` prefixes every DOM asset's `httpServerLocation`
 *     with `www.bundle`, so a **dev, preview or production build** puts the
 *     image beside the page and the URL resolves.
 *   - `exportDomComponents.js`, which is `expo export` and therefore **EAS
 *     Update**, does not. The image lands in `dist/assets/` and the page asks
 *     for a sibling that is not there.
 *
 * The two layouts disagree, so no single relative URL is right for both. Both
 * agree on a URL with nothing to resolve, which is what this writes.
 *
 * ## Why it is generated rather than written by hand
 *
 * Because it must not be able to drift from the PNG. `--check` re-derives every
 * file and fails if a byte differs, so a designer replacing the wordmark cannot
 * leave the phone showing the old one. That check is `verify:shell-assets` and
 * it is pure Node, so it runs in the suite without an export.
 *
 * ## Why this cost lands on the phone and not the web
 *
 * The web app keeps importing the PNG, so its build keeps a hashed, separately
 * cacheable file. `apps/mobile/metro.config.js` swaps the import for the module
 * written here, so the ~17 KB of base64 is only in the bundle that needs it. On
 * the login screen it is arguably the better trade anyway: the wordmark is the
 * first thing drawn and now costs no round trip.
 *
 *   node scripts/gen-shell-assets.mjs           # write
 *   node scripts/gen-shell-assets.mjs --check   # fail if stale
 */

/** Every image the shell's bundle asks for by import. */
const ASSETS = [
  { png: 'src/assets/logo.png', out: 'apps/mobile/src/assets/logo.png.ts' },
  { png: 'src/assets/icon-192.png', out: 'apps/mobile/src/assets/icon-192.png.ts' },
]

const check = process.argv.includes('--check')
const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

function moduleFor({ png, bytes }) {
  const sha = createHash('sha256').update(bytes).digest('hex')
  return `/*
 * GENERATED — do not edit. Run \`node scripts/gen-shell-assets.mjs\`.
 *
 * ${basename(png)} as a data URI, because the shell's page is loaded from a
 * local file and Metro's relative asset URL resolves differently under
 * \`expo export\` than under a native build. See the generator for the full
 * reason; \`npm run verify:shell-assets\` fails if this drifts from the PNG.
 *
 * source: ${png}
 * bytes:  ${bytes.length}
 * sha256: ${sha}
 */
export default 'data:image/png;base64,${bytes.toString('base64')}'
`
}

for (const asset of ASSETS) {
  const pngPath = resolve(asset.png)
  if (!existsSync(pngPath)) {
    ok(false, `${asset.png} is missing — the generator's list is out of date`)
    continue
  }
  const bytes = readFileSync(pngPath)
  const wanted = moduleFor({ png: asset.png, bytes })
  const outPath = resolve(asset.out)

  if (check) {
    const have = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null
    ok(
      have === wanted,
      have === null
        ? `${asset.out} does not exist — run node scripts/gen-shell-assets.mjs`
        : `${asset.out} is in sync with ${asset.png}`,
    )
    continue
  }

  writeFileSync(outPath, wanted)
  console.log(`wrote ${asset.out}  (${bytes.length} B → ${wanted.length} B)`)
}

if (check) {
  console.log(fails.length ? `\n${fails.length} generated asset(s) are stale.` : '\nEvery inlined asset matches its PNG.')
  process.exit(fails.length ? 1 : 0)
}
