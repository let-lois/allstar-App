import { SERIES, SINGLE, FUNNEL_RAMP, STATUS, INK } from '../src/admin/charts/tokens.ts'
import { ratio } from './lib/contrast.mjs'
import {
  BAND,
  CHROMA_FLOOR,
  CVD_TARGET,
  NORMAL_FLOOR,
  ORDINAL_MIN_DL,
  deltaE,
  okhue,
  oklch,
  worstAdjacent,
} from './lib/cvd.mjs'

/**
 * The chart palette, measured rather than remembered.
 *
 * The office console draws two line series, a five-step funnel ramp and four
 * status colours on a dark card. Colour is doing identity work there: which line
 * is knocks and which is conversations is carried by hue and nothing else, and a
 * rep or a manager with protanopia — roughly one man in twelve — has to be able
 * to tell them apart.
 *
 * This existed as prose before it existed as a gate. `charts/tokens.ts` quoted
 * ΔE figures from a validator that was not in this repo, and when the theme moved
 * to a dark ground those figures silently became claims about a surface that no
 * longer existed. The file said so, which was honest, and left the numbers wrong,
 * which was still wrong. The maths lives in `lib/cvd.mjs` now, so this is
 * re-derivable by anyone who edits a hex.
 *
 * No browser: colour is arithmetic.
 */

const SURFACE = INK.surface
const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

console.log('--- the two line series ---')

/*
  Colour-blindness first, because it is the check with a person behind it. The
  target is ΔE 8; anything between 6 and 8 is a floor that is only legal with a
  second encoding, and these charts carry a legend but the lines themselves are
  told apart by colour alone at the point where they cross.
*/
const cvd = worstAdjacent(SERIES, 'cvd')
ok(
  cvd.worst >= CVD_TARGET,
  'the series stay apart under protanopia and deuteranopia',
  `ΔE ${cvd.worst.toFixed(1)}, target ${CVD_TARGET}`,
)
ok(
  deltaE(SERIES[0], SERIES[1], 'tritan') >= CVD_TARGET,
  'and under tritanopia',
  `ΔE ${deltaE(SERIES[0], SERIES[1], 'tritan').toFixed(1)}`,
)

/*
  And for everyone else. A pair can be colour-blind-safe and still be two blues
  nobody can tell apart — this is the floor that catches that, and no amount of
  legend or direct labelling excuses it.
*/
const normal = worstAdjacent(SERIES)
ok(
  normal.worst >= NORMAL_FLOOR,
  'and are easy to tell apart in full colour too',
  `ΔE ${normal.worst.toFixed(1)}, floor ${NORMAL_FLOOR}`,
)

for (const [i, c] of SERIES.entries()) {
  const { L, C } = oklch(c)
  ok(
    L >= BAND.dark[0] && L <= BAND.dark[1],
    `series ${i} (${c}) sits in the lightness band a dark ground wants`,
    `L ${L.toFixed(3)} in ${BAND.dark[0]}–${BAND.dark[1]}`,
  )
  ok(
    C >= CHROMA_FLOOR,
    `series ${i} (${c}) is a colour rather than a grey`,
    `C ${C.toFixed(3)}, floor ${CHROMA_FLOOR}`,
  )
  ok(ratio(c, SURFACE) >= 3, `series ${i} (${c}) reads against the card`, `${ratio(c, SURFACE).toFixed(2)}:1`)
}

ok(SERIES.includes(SINGLE), 'a one-series chart uses a colour the two-series charts also use', SINGLE)

console.log('\n--- the funnel ramp ---')

/*
  An ordinal ramp fails by having two neighbouring steps nobody can separate,
  which no per-step contrast check can see: both can clear the surface easily
  and still be the same colour as each other. Lightness distance is the check
  that catches it.
*/
const ramps = FUNNEL_RAMP.map(oklch)
let monotone = true
for (let i = 1; i < ramps.length; i++) if (ramps[i].L <= ramps[i - 1].L) monotone = false
ok(monotone, 'the ramp runs one direction the whole way', ramps.map((r) => r.L.toFixed(2)).join(' → '))

let worstDl = Infinity
for (let i = 1; i < ramps.length; i++) worstDl = Math.min(worstDl, ramps[i].L - ramps[i - 1].L)
ok(
  worstDl >= ORDINAL_MIN_DL,
  'and every step is visibly further along than the one before it',
  `smallest ΔL ${worstDl.toFixed(3)}, floor ${ORDINAL_MIN_DL}`,
)

const hues = FUNNEL_RAMP.map(okhue)
const spread = Math.max(...hues) - Math.min(...hues)
ok(
  spread <= 20,
  'the ramp is one hue, so it reads as an order rather than as five identities',
  `${spread.toFixed(0)}° spread`,
)

const dimmest = ratio(FUNNEL_RAMP[0], SURFACE)
ok(dimmest >= 3, 'the dim end still reads against the card', `${dimmest.toFixed(2)}:1`)

console.log('\n--- status colours ---')

/*
  Reserved for state and never for a series, and always shipped beside an icon
  or a label — so what is checked is that each one is legible on the card, not
  that they are separable from each other. Nothing should ever be asked to tell
  "warning" from "serious" by colour alone.
*/
for (const [name, c] of Object.entries(STATUS)) {
  ok(ratio(c, SURFACE) >= 3, `status ${name} (${c}) reads against the card`, `${ratio(c, SURFACE).toFixed(2)}:1`)
}
const statusSet = new Set(Object.values(STATUS))
ok(
  ![...SERIES, SINGLE].some((c) => statusSet.has(c.toUpperCase()) || statusSet.has(c.toLowerCase())),
  'no status colour is doubling as a series colour',
)

console.log('\n--- the comments are not lying ---')

/*
  The figures quoted in tokens.ts are the reason anyone trusts the file without
  running this. Checked against what was just measured, to one decimal, because
  a stale comment is how the last set of numbers survived a redesign that
  invalidated them.
*/
const source = (await import('node:fs')).readFileSync(
  new URL('../src/admin/charts/tokens.ts', import.meta.url),
  'utf8',
)
const claims = [
  [`protan/deutan ΔE ${cvd.worst.toFixed(1)}`, 'the CVD separation it claims'],
  [`normal-vision ΔE ${normal.worst.toFixed(1)}`, 'the normal-vision figure it claims'],
  [`${ratio(SERIES[0], SURFACE).toFixed(2)}:1`, 'the first series contrast it claims'],
  [`${ratio(SERIES[1], SURFACE).toFixed(2)}:1`, 'the second series contrast it claims'],
  [`${dimmest.toFixed(2)}:1`, "the ramp's dim-end contrast it claims"],
]
for (const [needle, what] of claims) {
  ok(source.includes(needle), `tokens.ts still quotes ${what}`, needle)
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log(`\n=== charts OK (${SERIES.length} series, ${FUNNEL_RAMP.length}-step ramp) ===`)
