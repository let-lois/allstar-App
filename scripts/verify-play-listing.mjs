import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Google Play listing text and graphics, against Play's upload limits.
 *
 * The Console refuses an over-long description or a wrongly sized image only
 * at the moment of pasting or uploading — so the copy and the files in
 * docs/google-play are checked here instead: every limit is measured from the
 * text and the PNG headers themselves, nothing is estimated.
 *
 *   npm run verify:play-listing
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = resolve(root, 'docs/google-play')
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}

/* --- text ------------------------------------------------------------------ */
const md = readFileSync(resolve(dir, 'PLAY_STORE_LISTING.md'), 'utf8')
/** The fenced block under a `## heading` that starts with `prefix`. */
const block = (prefix) => {
  const at = md.indexOf(`## ${prefix}`)
  if (at < 0) return null
  const m = /```\n([\s\S]*?)\n```/.exec(md.slice(at))
  return m ? m[1] : null
}
// Play counts characters as the person sees them; spread to count code points.
const len = (s) => [...s].length

const title = block('App name')
const short = block('Short description')
const full = block('Full description')
const notes = block('Release notes')
ok(!!title && len(title) <= 30, 'app name fits Play’s 30 characters', title && len(title))
ok(!!short && len(short) <= 80, 'short description fits 80 characters', short && len(short))
ok(!!full && len(full) <= 4000, 'full description fits 4,000 characters', full && len(full))
ok(!!notes && len(notes) <= 500, 'release notes fit 500 characters', notes && len(notes))
// Google's metadata policy: no prices, rankings, or calls to action in the
// title and short description, and no emoji or ALL CAPS in the title.
ok(!/free|best|#1|top|download|install|new/i.test(`${title} ${short}`), 'name and short description carry no promotional words Play rejects')
ok(!/\p{Extended_Pictographic}/u.test(`${title}${short}`), 'and no emoji')
ok(full && full.includes('/delete-account') && full.includes('/privacy'), 'the description tells people how to delete their account and where the policy is')

/* --- graphics -------------------------------------------------------------- */
/** Width, height and whether the PNG can carry transparency, from its header. */
function png(path) {
  const b = readFileSync(path)
  if (b.readUInt32BE(0) !== 0x89504e47) return null
  const w = b.readUInt32BE(16)
  const h = b.readUInt32BE(20)
  const colorType = b[25]
  // 4 = grey+alpha, 6 = RGBA; a tRNS chunk adds transparency to the others.
  const alpha = colorType === 4 || colorType === 6 || b.includes(Buffer.from('tRNS'))
  return { w, h, alpha, bytes: b.length }
}
const assets = resolve(dir, 'assets')

const icon = existsSync(resolve(assets, 'icon-512.png')) && png(resolve(assets, 'icon-512.png'))
ok(!!icon && icon.w === 512 && icon.h === 512 && icon.bytes <= 1024 * 1024, 'the icon is 512 × 512 and under 1 MB', icon && `${icon.w}×${icon.h} ${Math.round(icon.bytes / 1024)}KB`)

const fg = existsSync(resolve(assets, 'feature-graphic.png')) && png(resolve(assets, 'feature-graphic.png'))
ok(!!fg && fg.w === 1024 && fg.h === 500, 'the feature graphic is 1024 × 500', fg && `${fg.w}×${fg.h}`)
ok(!!fg && !fg.alpha, 'with no transparency, which Play refuses on a feature graphic')

for (const [set, min, max] of [['phone', 2, 8], ['tablet-7in', 0, 8], ['tablet-10in', 0, 8]]) {
  const p = resolve(assets, set)
  const files = existsSync(p) ? readdirSync(p).filter((f) => f.endsWith('.png')).sort() : []
  ok(files.length >= min && files.length <= max, `${set}: between ${min} and ${max} screenshots`, files.length)
  for (const f of files) {
    const i = png(resolve(p, f))
    const ratio = Math.max(i.w, i.h) / Math.min(i.w, i.h)
    ok(
      i.w >= 320 && i.h >= 320 && i.w <= 3840 && i.h <= 3840 && ratio <= 2 && i.bytes <= 8 * 1024 * 1024,
      `${set}/${f}: sides 320–3840 px, at most 2:1, under 8 MB`,
      `${i.w}×${i.h} ${ratio.toFixed(2)}:1`,
    )
  }
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed`)
  process.exit(1)
}
console.log('=== the Play listing fits every limit Google enforces ===')
