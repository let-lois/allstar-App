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
 * than icons: the ellipsis in "Saving…", the bullet between fields, en and em
 * dashes, the "no value" en dash in a table cell, `•` in a password
 * placeholder, and the outcome set's own marks (★ ↻ ◷ ✕ ✓ ⊘ — a designed
 * family that lives inside coloured pills and is chosen per outcome by a client
 * admin). Those are listed by codepoint below rather than waved through by
 * category, so adding one is a decision somebody makes on purpose.
 */

const SRC = globSync('src/**/*.{ts,tsx}')

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
 * Marks that are text, not icons. By codepoint, with the reason.
 *
 * `•` earns its place twice over: it is the separator between two facts on a
 * row, and it is what a password field shows.
 */
const ALLOWED = new Set([
  '•', // separator, and the password placeholder
  '★', '↻', '◷', '✕', '✓', '⊘', '—', '–', '·', '↳', '↑', '↓', '→', '←', '⚠',
])

/*
  The outcome set and the few places a typographic mark is still correct. Named
  files rather than a blanket exemption: a new file reaching for a dingbat has
  to be added here, which is the conversation this gate exists to start.
*/
const TEXT_MARK_FILES = new Set([
  'src/data/outcomes.ts', // ★ ↻ ◷ ✕ ✓ ⊘ — the outcome family, in coloured pills
  'src/screens/VisitMode.tsx', // the same marks, in the outcome grid
  'src/screens/StreetScreen.tsx', // · — ✓ as knocked/not-knocked marks in a strip
  'src/screens/RouteScreen.tsx', // – for a skipped stop
  'src/admin/AdminImport.tsx', // ↳ "matched to", and ✓ on a finished step
  'src/lib/csv.ts', // File → Save As, in a sentence
  'src/lib/http.ts', // ••••abcd, a masked token
  'src/screens/Login.tsx', // the password placeholder
  'src/admin/IntegrationsPanel.tsx', // Settings → Private Integrations, in a sentence
])

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
      if (ALLOWED.has(ch) && TEXT_MARK_FILES.has(file)) continue
      // Separators and dashes are punctuation wherever they appear.
      if (ch === '•' || ch === '·' || ch === '—' || ch === '–') continue
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
