import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'

/**
 * No emoji, and no character standing in for an icon.
 *
 * The app shipped with 🏆 🔥 💰 📅 on the award badges, 🏠 🧱 ⚠ 🛋 📄 on the
 * photo categories, 📞 and ▶ on the swipe actions, ☀ ☾ and a capital A on the
 * theme toggle, and ✕ ◎ ☎ ★ ↻ ↑ ↓ scattered through the chrome as buttons.
 *
 * Why that is worth a gate rather than a tidy-up. An emoji is the one graphic
 * in this interface that cannot be themed, sized or measured: the OS picks the
 * artwork, it ignores `currentColor`, it sits on the text baseline instead of
 * centred in its target, and it is a different house style on every handset the
 * team owns — so a screen that looks composed on one phone looks assembled on
 * another. The dingbats are the same problem in monochrome, plus one of their
 * own: they take whatever the system font has, which at 12px is often a shape
 * with no relation to the one that was intended.
 *
 * Every one of them is now an SVG in `nav/icons.tsx` on a 24px grid, in
 * `currentColor`. This keeps them out, because the cheapest thing in the world
 * to type when you need a glyph in a hurry is an emoji.
 *
 * **What is deliberately allowed.** Typographic marks that are *text* rather
 * than icons: em dashes and interpuncts anywhere, because they are punctuation
 * in prose; and six marks in six named files — a password placeholder, an en
 * dash for a skipped stop, a tick for a knocked door, and the arrow in a menu
 * path written out in a sentence. Named file by file below, so reaching for one
 * somewhere new is a decision somebody makes on purpose rather than a character
 * that happens to be on a list.
 */

/*
  Two roots since the extraction: the app, and `packages/core`, which is where
  the platform-free half of the domain now lives. Scanning only `src` would
  have quietly stopped covering the moved files — and a gate that stops looking
  is worse than one that fails, because it still prints PASS.
*/
const SRC = [...globSync('src/**/*.{ts,tsx}'), ...globSync('packages/core/src/**/*.ts')]

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/*
  Pictographic characters — the emoji blocks proper, plus the dingbats and
  arrows that get pressed into service as buttons.

  `©` and `®` are deliberately absent: they are never an icon. The first
  version of this gate included them and flagged the map's tile attribution,
  which is a legal notice in a sentence.
*/
const SUSPECT = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{FE0F}\u{2022}]/u

/**
 * Marks that are text, not icons — per file, with the reason.
 *
 * Per file rather than one global list of marks crossed with one list of files:
 * the cross product let any exempt file use any exempt mark, which is how ★
 * kept an exemption in three files that had never typed it. A file may use the
 * marks named against it and nothing else.
 *
 * The outcome family (★ ↻ ◷ ✕ ✓ ⊘) used to be the bulk of this list. It is
 * gone: all eight outcomes name an icon in `data/outcomes.ts` now, so the
 * characters this exemption existed for are no longer in the product.
 */
const TEXT_MARKS = new Map([
  ['src/screens/Login.tsx', '•'], // the password placeholder
  ['src/screens/RouteScreen.tsx', '–'], // an en dash for a skipped stop
  ['src/screens/StreetScreen.tsx', '✓'], // knocked, in a strip of doors
  ['src/admin/AdminImport.tsx', '↳✓→'], // "matched to", a finished step, and a menu path
  ['packages/core/src/csv.ts', '→'], // File → Save As, in a sentence
  ['src/admin/IntegrationsPanel.tsx', '→'], // Settings → Private Integrations, in a sentence
])

/*
  Dashes and the interpunct are punctuation wherever they appear — 51 files use
  an em dash and 29 an interpunct, all of it prose, and nobody has ever mistaken
  one for a button.

  `•` is deliberately NOT here. A bullet is exactly the character somebody
  reaches for wanting a dot-shaped icon in a hurry, so it is allowed in the one
  file that draws a password and nowhere else.
*/
const PUNCTUATION = new Set(['—', '·'])

/**
 * Comments out, line numbers kept.
 *
 * The first version tested each line for a leading `*`, `//` or `/*`, and
 * flagged this file's own siblings: the house style here is a `/* ... *\/`
 * block whose prose lines start with a plain word, and several of those blocks
 * exist precisely to say which glyph was removed and why. A gate that fails on
 * the comment explaining the fix is a gate people delete.
 *
 * Block comments and line comments are blanked to spaces so every offset —
 * and therefore every line number — survives.
 */
function stripComments(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? source.length : end + 2
      for (let j = i; j < stop; j++) out += source[j] === '\n' ? '\n' : ' '
      i = stop
    } else if (two === '//') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i++ }
    } else {
      out += source[i]
      i++
    }
  }
  return out
}

const hits = []
for (const file of SRC) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    for (const ch of line) {
      if (!SUSPECT.test(ch)) continue
      if (PUNCTUATION.has(ch)) continue
      if (TEXT_MARKS.get(file)?.includes(ch)) continue
      hits.push({ file, line: i + 1, ch, text: line.trim().slice(0, 90) })
    }
  })
}

ok(SRC.length > 100, `the source was read (${SRC.length} files)`)
ok(
  hits.length === 0,
  hits.length === 0
    ? 'no emoji or stand-in glyph is used as a UI element'
    : `these use a character where an icon belongs: ${hits
        .map((h) => `${h.file}:${h.line} ${h.ch}`)
        .join(', ')}`,
)

/*
  And the icon set is actually reachable — a gate that only forbids is a gate
  that gets satisfied by deleting the glyph and shipping a blank button.
*/
const icons = readFileSync('src/components/nav/icons.tsx', 'utf8')
const exported = [...icons.matchAll(/export const (Icon[A-Za-z]+)/g)].map((m) => m[1])
ok(exported.length >= 35, `the icon set is large enough to reach for (${exported.length} icons)`)
for (const needed of ['IconSun', 'IconMoon', 'IconDevice', 'IconFilter', 'IconList', 'IconSignOut']) {
  ok(exported.includes(needed), `${needed} exists, so nobody has to type a character instead`)
}

/* Every icon is one drawing, in the app's colour, on the same grid. */
const bodies = icons.split(/export const Icon/).slice(1)
const wrongColour = bodies.filter((b) => /fill="#|stroke="#/.test(b)).length
ok(wrongColour === 0, 'no icon hardcodes a colour — they all take the tone of what they sit in', `${wrongColour}`)

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== icons, not characters ===')
