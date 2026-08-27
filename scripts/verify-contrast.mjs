import fs from 'node:fs'
import { ratio, over, toHex, parseHex } from './lib/contrast.mjs'
import { INK, SERIES, FUNNEL_RAMP } from '../src/admin/charts/tokens.ts'

/**
 * Contrast gate for the dark theme.
 *
 * The app is used outdoors, one-handed, by someone who cannot stop to squint.
 * Every colour decision in this repo claims a measured ratio in a comment; this
 * is what stops those comments drifting away from the values they describe.
 *
 * It reads the real theme out of `index.css` rather than restating it, so
 * editing a variable and forgetting the consequence fails here instead of on a
 * porch.
 *
 * Deliberately no browser: the values, their relationships, and the arithmetic
 * are all knowable without one, and a gate that needs a build and a server is a
 * gate people skip. The rendered-DOM sweep lives in `audit-viewports.mjs`.
 */

const AA_TEXT = 4.5
const AA_GRAPHIC = 3.0

const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

/** Pull `--name: r g b;` out of the theme block. */
function themeVar(name) {
  const m = css.match(new RegExp(`--${name}:\\s*([0-9]+)\\s+([0-9]+)\\s+([0-9]+)\\s*;`))
  if (!m) throw new Error(`theme variable --${name} not found in index.css`)
  return toHex([Number(m[1]), Number(m[2]), Number(m[3])])
}

const T = {}
for (const n of [
  'ink', 'ink-soft', 'ink-mute', 'ink-faint',
  'surface', 'surface-sunk', 'surface-tint', 'surface-field', 'surface-raised',
  'line', 'line-soft', 'line-card', 'accent', 'accent-strong',
  'good', 'good-bg', 'warn', 'warn-bg', 'bad', 'bad-bg', 'info', 'info-bg',
]) T[n] = themeVar(n)

const fails = []
const checks = []
function ok(cond, msg, measured) {
  checks.push(cond)
  const line = `${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`
  console.log(line)
  if (!cond) fails.push(msg)
}
const at = (fg, bg, floor, label) => {
  const r = ratio(fg, bg)
  ok(r >= floor, label, `${r.toFixed(2)} vs ${floor}`)
}

/* -------------------------------------------------------------------------
 * 1. Text on every surface it can land on.
 * ---------------------------------------------------------------------- */
console.log('\n--- text tokens on every ground ---')
const GROUNDS = ['surface', 'surface-sunk', 'surface-raised', 'surface-field', 'surface-tint']
for (const g of GROUNDS) {
  for (const t of ['ink', 'ink-soft', 'ink-mute']) {
    at(T[t], T[g], AA_TEXT, `${t} on ${g}`)
  }
  at(T['accent'], T[g], AA_TEXT, `accent on ${g}`)
}

/*
 * ink-faint is the one tone allowed to fail as text, because it is not text —
 * it is dividers, placeholders and disabled glyphs. Asserting the *ceiling*
 * keeps it honest: if someone lightens it until it passes, it has quietly
 * become a text colour and the distinction this palette rests on is gone.
 */
console.log('\n--- ink-faint stays decorative ---')
const faint = ratio(T['ink-faint'], T['surface'])
ok(faint < AA_TEXT, 'ink-faint is below the text floor, so it cannot be mistaken for one', faint.toFixed(2))
ok(faint >= 3.0, 'ink-faint still reads as a graphic', faint.toFixed(2))

/* -------------------------------------------------------------------------
 * 2. The machined faces.
 *
 * These are gradients with a white sheen composited over the top half, and the
 * label sits in exactly that band — so the number that matters is the lightest
 * point, not the declared colour. This is the trap the light theme hit from the
 * other side, and it is worth a test precisely because it is invisible to one.
 * ---------------------------------------------------------------------- */
console.log('\n--- machined faces, measured at their lightest point ---')
const face = (top, sheen) => toHex(over('#ffffff', sheen, top))

const metalRow = face('#143240', 0.07)
at(T['ink'], metalRow, AA_TEXT, 'ink on a metal row')
at(T['ink-soft'], metalRow, AA_TEXT, 'ink-soft on a metal row')
at(T['accent-strong'], metalRow, AA_TEXT, 'accent-strong on a metal row')
const muteOnRow = ratio(T['ink-mute'], metalRow)
ok(muteOnRow < AA_TEXT,
   'ink-mute is still too quiet for a metal row (the comment in index.css says so)',
   muteOnRow.toFixed(2))

const metalRowBrand = face('#17495c', 0.07)
at(T['ink'], metalRowBrand, AA_TEXT, 'ink on a selected metal row')
at(T['ink-soft'], metalRowBrand, AA_TEXT, 'ink-soft on a selected metal row')
at(T['accent-strong'], metalRowBrand, AA_TEXT, 'accent-strong on a selected metal row')

/*
 * Selection is carried by two channels. The faces differ by very little — by
 * design, since brightening the selected one far enough to stand alone drops
 * its own text under AA — so the teal ring is what actually finds it. Assert
 * both: the ring against the face beside it, and that the two faces really are
 * too close to rely on, which is the reason the ring has to exist.
 */
const ringVsNeighbour = ratio(T['accent'], metalRow)
ok(ringVsNeighbour >= AA_GRAPHIC, 'the selected row\'s ring reads against the row beside it',
   ringVsNeighbour.toFixed(2))
const faceVsFace = ratio(metalRowBrand, metalRow)
ok(faceVsFace < 2, 'the two row faces are close enough that the ring is load-bearing, not decoration',
   faceVsFace.toFixed(2))

/*
 * The two edge strengths, and the distance between them.
 *
 * Every control now wears a teal edge, which is what the app is meant to look
 * like — and it costs selection the thing that used to identify it. Before this,
 * a ring meant "chosen" because nothing else had one; now a ring means "control"
 * and only its *strength* means chosen. With the faces 1.33:1 apart, closing
 * that gap would put us back at a selected row nobody can pick out, which is a
 * bug this app has already shipped once.
 *
 * So both ends are pinned: the resting edge has to be worth having over the
 * hairline it replaced, and the selected ring has to stay clear of it.
 */
const edgeAlpha = (name) => {
  const m = css.match(new RegExp(`--${name}:\\s*rgb\\(var\\(--([a-z-]+)\\)\\s*/\\s*([0-9.]+)\\)`))
  if (!m) throw new Error(`--${name} is not an rgb(var(--token) / alpha) edge in index.css`)
  return { token: m[1], alpha: Number(m[2]) }
}
const rest = edgeAlpha('edge')
const strong = edgeAlpha('edge-strong')
const restOnGround = over(T[rest.token], rest.alpha, T['surface-sunk'])
const strongOnFace = over(T[strong.token], strong.alpha, metalRowBrand)
const hairline = T['line']

const edgeVsGround = ratio(restOnGround, T['surface-sunk'])
ok(edgeVsGround >= 2, 'the resting edge is visible on the ground it sits on', edgeVsGround.toFixed(2))

const edgeVsHairline = ratio(restOnGround, hairline)
ok(edgeVsHairline > 1.2,
   'and is a real step up from the hairline it replaced, not a repaint of it',
   edgeVsHairline.toFixed(2))

const selectedVsResting = ratio(strongOnFace, restOnGround)
ok(selectedVsResting >= AA_GRAPHIC,
   'a selected control still reads against a control merely at rest',
   selectedVsResting.toFixed(2))

const metalQuiet = face('#232e44', 0.06)
at(T['ink'], metalQuiet, AA_TEXT, 'ink on a gunmetal control')
/*
 * A labelled control on that face — the header's logout button. `ink-mute`
 * measures 4.36:1 here and would fail, which is worth pinning rather than
 * rediscovering: the quiet tone that is right for a loose icon on the header's
 * own ground is not right once the icon sits on a raised face.
 */
at(T['ink-soft'], metalQuiet, AA_TEXT, 'a label on a gunmetal control')

/*
 * The primary button keeps a near-black label on a bright teal face. Both ends
 * are literal and neither moves with the theme, which is the whole reason it
 * survived the inversion untouched — but it is also the single most-pressed
 * control in the app, so it gets measured at both ends of its gradient.
 */
at('#111827', face('#7fe0ef', 0.3), AA_TEXT, 'metal-brand label at the face\'s lightest point')
at('#111827', '#0fa9b8', AA_TEXT, 'metal-brand label at the face\'s darkest point')

/* -------------------------------------------------------------------------
 * 3. Saturated fills that carry their own labels.
 * ---------------------------------------------------------------------- */
console.log('\n--- self-contained fills ---')
at('#ffffff', '#087F8C', AA_TEXT, 'white on brand-600, the filled interactive teal')
at('#087F8C', T['surface-sunk'], AA_GRAPHIC, 'brand-600 reads as a shape on the ground')
for (const [n, v] of [['good', T.good], ['warn', T.warn], ['bad', T.bad]]) {
  at(T['surface-sunk'], v, AA_TEXT, `the ground colour as a label on a bright ${n} fill`)
}

console.log('\n--- status text on its own tint ---')
for (const n of ['good', 'warn', 'bad', 'info']) {
  at(T[n], T[`${n}-bg`], AA_TEXT, `${n} on ${n}-bg`)
  at(T[n], T['surface'], AA_TEXT, `${n} on a card`)
}

/* -------------------------------------------------------------------------
 * 4. Chart tokens.
 *
 * A chart cannot read a CSS variable — `tokens.ts` restates the theme as hexes
 * for the SVG renderer. Restating anything is how two sources of truth start,
 * so this asserts they are the same values rather than trusting a comment.
 * ---------------------------------------------------------------------- */
console.log('\n--- chart chrome tracks the theme ---')
ok(INK.surface.toLowerCase() === T['surface'].toLowerCase(),
   'chart surface matches --surface', `${INK.surface} vs ${T['surface']}`)
ok(INK.primary.toLowerCase() === T['ink'].toLowerCase(),
   'chart primary ink matches --ink', `${INK.primary} vs ${T['ink']}`)
ok(INK.secondary.toLowerCase() === T['ink-soft'].toLowerCase(),
   'chart secondary ink matches --ink-soft', `${INK.secondary} vs ${T['ink-soft']}`)
ok(INK.muted.toLowerCase() === T['ink-mute'].toLowerCase(),
   'chart muted ink matches --ink-mute', `${INK.muted} vs ${T['ink-mute']}`)
ok(INK.grid.toLowerCase() === T['line-soft'].toLowerCase(),
   'chart gridlines match --line-soft', `${INK.grid} vs ${T['line-soft']}`)
ok(INK.axis.toLowerCase() === T['line'].toLowerCase(),
   'chart axis matches --line', `${INK.axis} vs ${T['line']}`)

console.log('\n--- chart series on the chart surface ---')
SERIES.forEach((c, i) => at(c, INK.surface, AA_GRAPHIC, `series ${i} (${c}) on the card`))
FUNNEL_RAMP.forEach((c, i) => at(c, INK.surface, AA_GRAPHIC, `funnel step ${i} (${c}) on the card`))
/*
 * The ramp's step-to-step separation used to be approximated here with a
 * contrast ratio between neighbours — a deliberately weak stand-in for a ΔL
 * check this repo could not perform. It can now: `verify:charts` measures OKLCH
 * lightness distance directly, along with the colour-blindness separation this
 * file never claimed to cover. Two checks of the same thing would drift apart,
 * and the weaker one would be the one nobody noticed had stopped mattering.
 */

/* -------------------------------------------------------------------------
 * 5. Outcome and status pills.
 * ---------------------------------------------------------------------- */
const outcomes = fs.readFileSync(new URL('../src/data/outcomes.ts', import.meta.url), 'utf8')
const toneBlock = outcomes.slice(outcomes.indexOf('STATUS_TONE'))
const tonePairs = [...toneBlock.matchAll(/(\w+): \{ fg: '(#[0-9A-Fa-f]{6})', bg: '(#[0-9A-Fa-f]{6})' \}/g)]
console.log('\n--- lead status pills ---')
ok(tonePairs.length === 8, 'all eight lead statuses have a tone pair', `${tonePairs.length}`)
for (const [, name, fg, bg] of tonePairs) at(fg, bg, AA_TEXT, `${name} pill`)

const swatchBlock = outcomes.slice(outcomes.indexOf('STATUS_COLOR'), outcomes.indexOf('STATUS_TONE'))
const swatches = [...swatchBlock.matchAll(/(\w+): '(#[0-9A-Fa-f]{6})'/g)]
console.log('\n--- map swatches on the basemap ---')
/*
 * Read the basemap's ground out of the map itself. Hard-coding it here would
 * make this section pass forever while the map drifted underneath it, which is
 * the failure mode a gate is supposed to prevent rather than demonstrate.
 */
const fieldMap = fs.readFileSync(new URL('../src/components/map/FieldMap.tsx', import.meta.url), 'utf8')
const groundMatch = fieldMap.match(/<rect width=\{size\.w\} height=\{size\.h\} fill="(#[0-9A-Fa-f]{6})" \/>/)
ok(Boolean(groundMatch), 'the basemap ground fill is findable in FieldMap')
const MAP_GROUND = groundMatch ? groundMatch[1] : '#ffffff'
console.log(`    basemap ground: ${MAP_GROUND}`)
for (const [, name, hex] of swatches) at(hex, MAP_GROUND, AA_GRAPHIC, `${name} pin on the basemap`)

/* -------------------------------------------------------------------------
 * 6. The ground itself.
 * ---------------------------------------------------------------------- */
console.log('\n--- structure ---')


/* --- the two border strengths ------------------------------------------------ */
//
// A panel's edge and a hairline are different jobs and used to be the same
// colour, which is why the Overview read as a wash: two columns of tiles whose
// boundaries you had to hunt for on a phone held at arm's length.
//
// Both ends are pinned, because the reason they are separate tokens is a
// constraint rather than a preference. Raising `--line` itself was the obvious
// fix, and it repaints every chart: the axis is pinned to `--line` below, and
// the seam assertion at the end of this block is what stops a divider growing
// into a second outline around every row.
const panelEdge = T['line-card']

/*
  The floor here is deliberately far above the 3:1 a non-text mark needs.

  A merely *adequate* panel edge is what this replaced, twice. The first attempt
  measured 3.20:1 — comfortably over the graphic floor, sound by every rule in
  this file, and still not what had been asked for: on the phone it read as a
  grey app with faint boxes. The screen was rejected a second time before the
  edge went white.

  So the assertion is pinned near the top of the scale rather than at the
  threshold. This is the number to argue with if the edge should soften — not
  something to slide underneath while the gate stays green.
*/
const PANEL_FLOOR = 12

const panelOnCard = ratio(panelEdge, T['surface'])
ok(panelOnCard >= PANEL_FLOOR,
   'a panel edge is unmistakable against the card it encloses, not merely adequate',
   panelOnCard.toFixed(2))

const panelOnGround = ratio(panelEdge, T['surface-sunk'])
ok(panelOnGround >= PANEL_FLOOR,
   'and against the ground it sits on',
   panelOnGround.toFixed(2))

/*
  Width is half of "thick white border" and a colour check cannot see it.
  Without this, dropping `border-2` leaves every measurement above untouched and
  the gate green while the screen quietly goes back to hairlines.
*/
for (const cls of ['card', 'panel']) {
  const rule = css.match(new RegExp(`\\.${cls}\\s*\\{[^}]*`))?.[0] ?? ''
  ok(/border-2\s+border-line-card/.test(rule),
     `.${cls} draws that edge at 2px, not as a hairline`)
}

const panelVsHairline = ratio(panelEdge, hairline)
ok(panelVsHairline >= 2,
   'the panel edge and the hairline are two strengths, not one repainted',
   panelVsHairline.toFixed(2))

/*
  The hairline stays quiet, deliberately. It is a seam inside a surface — a
  divider between rows, a chart axis — and a divider as loud as the box around it
  turns a list into a grid. This is the assertion that stops somebody "fixing"
  the dividers to match the border.
*/
ok(ratio(hairline, T['surface']) < AA_GRAPHIC,
   'and the hairline stays a seam rather than becoming a second outline',
   ratio(hairline, T['surface']).toFixed(2))
const lift = ratio(T['surface'], T['surface-sunk'])
ok(lift >= 1.04 && lift <= 1.35, 'a card lifts off the ground without jumping', lift.toFixed(2))
ok(parseHex(T['surface-field']).reduce((a, b) => a + b) < parseHex(T['surface']).reduce((a, b) => a + b),
   'an input is recessed — darker than the card it sits on, not lighter')

/* -------------------------------------------------------------------------
 * 7. The chrome outside the app.
 *
 * Three places restate the ground because they are read before any stylesheet
 * is: the browser's own chrome, the PWA splash, and the pre-paint background in
 * index.html. Drift here is invisible in every screenshot and obvious on a cold
 * start, as a band of the wrong navy or a white flash.
 * ---------------------------------------------------------------------- */
console.log('\n--- launch chrome matches the ground ---')
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const manifest = JSON.parse(
  fs.readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
)
const ground = T['surface-sunk'].toLowerCase()
const themeColor = html.match(/name="theme-color" content="(#[0-9A-Fa-f]{6})"/)?.[1]
const prePaint = html.match(/html\s*\{\s*background:\s*(#[0-9A-Fa-f]{6})/)?.[1]
ok(themeColor?.toLowerCase() === ground, 'index.html theme-color is the ground', `${themeColor} vs ${ground}`)
ok(prePaint?.toLowerCase() === ground, 'index.html pre-paint background is the ground', `${prePaint} vs ${ground}`)
ok(manifest.background_color.toLowerCase() === ground,
   'manifest background_color is the ground', `${manifest.background_color} vs ${ground}`)
ok(manifest.theme_color.toLowerCase() === ground,
   'manifest theme_color is the ground', `${manifest.theme_color} vs ${ground}`)

console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`)
if (fails.length) {
  console.log('\n=== FAILURES ===')
  fails.forEach((f) => console.log('- ' + f))
  process.exit(1)
}
console.log('\n=== contrast OK ===')
