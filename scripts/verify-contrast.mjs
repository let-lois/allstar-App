import fs from 'node:fs'
import { ratio, over, toHex, parseHex, resolveThemeColour } from './lib/contrast.mjs'
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

/**
 * Hex-valued tokens, and one `var()` hop to them.
 *
 * Both live in `lib/contrast.mjs` so the gates share one copy. Two of them had
 * already grown their own before that was written, which is the same shape of
 * problem as the hardcoded palettes this exercise was about.
 */
const hexVar = (name) => resolveThemeColour(`var(--${name})`, css)
const resolveColour = (value) => resolveThemeColour(value, css)

const T = {}
for (const n of [
  'ink', 'ink-soft', 'ink-mute', 'ink-faint',
  'surface', 'surface-sunk', 'surface-tint', 'surface-field', 'surface-raised',
  'line', 'line-soft', 'accent', 'accent-strong',
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
 * 2. The control faces.
 *
 * Flat, so each is one colour and the label sits on the colour it is measured
 * against. They used to be gradients with a white sheen over the top half, and
 * the number that mattered was the lightest point rather than the declared
 * colour — a trap the light theme hit from the other side. `face()` still
 * takes a sheen so the trap stays sayable; every face here passes 0.
 *
 * The hexes are read from index.css rather than restated, so a face that
 * changes there is measured here without anyone remembering to copy it.
 * ---------------------------------------------------------------------- */
console.log('\n--- control faces ---')
const face = (top, sheen) => toHex(over('#ffffff', sheen, top))
const declared = (selector, prop) => {
  const rule = css.match(new RegExp(`\\n  ${selector.replace(/[.\-]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
  const m = rule.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`${prop}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`${selector} declares no ${prop} hex in index.css`)
  return m[1]
}

const metalRow = face(declared('.metal-row', 'background'), 0)
at(T['ink'], metalRow, AA_TEXT, 'ink on a row')
at(T['ink-soft'], metalRow, AA_TEXT, 'ink-soft on a row')
at(T['accent-strong'], metalRow, AA_TEXT, 'accent-strong on a row')
// With the sheen gone, the quiet tone is legal on a row. Pinned so a face that
// creeps lighter is caught: the comment in index.css states this figure.
at(T['ink-mute'], metalRow, AA_TEXT, 'ink-mute on a row — legal now the face is flat')

const metalRowBrand = face(declared('.metal-row-brand', 'background'), 0)
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

const metalQuiet = face(declared('.metal-quiet', '--metal-top'), 0)
at(T['ink'], metalQuiet, AA_TEXT, 'ink on a gunmetal control')
/*
 * The unselected chip's label. It is `ink-mute` on this face, and on the old
 * sheened face that measured 4.36:1 — under AA on every filter row in the app,
 * and nothing here looked, because only `ink` and `ink-soft` were sampled.
 * Flat, it clears; pinned so it cannot creep back.
 */
at(T['ink-mute'], metalQuiet, AA_TEXT, 'the unselected chip label (ink-mute) on the quiet face')
/*
 * Chips: selection is carried by the face, so the resting ring can be neutral.
 *
 * The resting chip wore the teal `--edge` like every other control, and once
 * the faces went flat that ring was all the material left on it — eight rings
 * louder than the content under them. For the ring to step back, the fill has
 * to carry selection on its own: the chosen face against the resting one has
 * to clear the graphic floor. Both halves asserted, so neither can be undone
 * without the other.
 */
const brandFace = declared('.metal-brand', '--metal-top')
ok(ratio(brandFace, metalQuiet) >= AA_GRAPHIC,
   'a selected chip is found by its face alone against a resting one',
   ratio(brandFace, metalQuiet).toFixed(2))
{
  const rule = css.match(/\n  \.metal-quiet\s*\{([^}]*)\}/)?.[1].replace(/\/\*[\s\S]*?\*\//g, '') ?? ''
  ok(/--metal-ring:\s*var\(--hairline\)/.test(rule),
     'and so the resting chip wears the neutral hairline, keeping teal for what is chosen')
}
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
at('#111827', declared('.metal-brand', '--metal-top'), AA_TEXT, 'metal-brand label on its face')

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
ok(resolveColour(INK.surface).toLowerCase() === T['surface'].toLowerCase(),
   'chart surface matches --surface', `${resolveColour(INK.surface)} vs ${T['surface']}`)
ok(resolveColour(INK.primary).toLowerCase() === T['ink'].toLowerCase(),
   'chart primary ink matches --ink', `${resolveColour(INK.primary)} vs ${T['ink']}`)
ok(resolveColour(INK.secondary).toLowerCase() === T['ink-soft'].toLowerCase(),
   'chart secondary ink matches --ink-soft', `${resolveColour(INK.secondary)} vs ${T['ink-soft']}`)
ok(resolveColour(INK.muted).toLowerCase() === T['ink-mute'].toLowerCase(),
   'chart muted ink matches --ink-mute', `${resolveColour(INK.muted)} vs ${T['ink-mute']}`)
ok(resolveColour(INK.grid).toLowerCase() === T['line-soft'].toLowerCase(),
   'chart gridlines match --line-soft', `${resolveColour(INK.grid)} vs ${T['line-soft']}`)
ok(resolveColour(INK.axis).toLowerCase() === T['line'].toLowerCase(),
   'chart axis matches --line', `${resolveColour(INK.axis)} vs ${T['line']}`)

console.log('\n--- chart series on the chart surface ---')
SERIES.forEach((c, i) => at(c, resolveColour(INK.surface), AA_GRAPHIC, `series ${i} (${c}) on the card`))
FUNNEL_RAMP.forEach((c, i) => at(c, resolveColour(INK.surface), AA_GRAPHIC, `funnel step ${i} (${c}) on the card`))
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
const outcomes = fs.readFileSync(new URL('../packages/core/src/outcomes.ts', import.meta.url), 'utf8')
const toneBlock = outcomes.slice(outcomes.indexOf('STATUS_TONE'))
const tonePairs = [...toneBlock.matchAll(/(\w+): \{ fg: '(#[0-9A-Fa-f]{6})', bg: '(#[0-9A-Fa-f]{6})' \}/g)]
console.log('\n--- lead status pills ---')
/*
  Counted against STATUS_LABEL rather than a number written here.

  The literal `8` in this line was correct for a year and then wrong the moment a
  ninth status was added — and it failed for the *bookkeeping*, while the new
  pill itself measured fine. A hardcoded count turns "somebody added a status
  without a tone pair", which is the real risk, into "somebody added a status",
  which is not a problem at all. Reading the label table means a status with no
  tone pair still fails, and one with a pair still passes, with nothing to edit
  here either way.
*/
const labelBlock = outcomes.slice(outcomes.indexOf('STATUS_LABEL'), outcomes.indexOf('STATUS_COLOR'))
const statuses = [...labelBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])
ok(statuses.length > 0, 'the status list could be read at all', `${statuses.length} statuses`)
const toned = new Set(tonePairs.map(([, name]) => name))
const untoned = statuses.filter((s) => !toned.has(s))
ok(
  untoned.length === 0,
  'every lead status has a tone pair',
  untoned.length ? `missing: ${untoned.join(', ')}` : `${statuses.length} statuses, all paired`,
)
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
const groundMatch = fieldMap.match(/<rect width=\{size\.w\} height=\{size\.h\} fill="([^"]+)" \/>/)
ok(Boolean(groundMatch), 'the basemap ground fill is findable in FieldMap')
/*
  Accepts a token as well as a hex. The drawn map painted itself in literal hex
  and so stayed near-black in the light theme; the fill is `var(--map-ground)`
  now, and a regex that only knew hex would have reported the fill missing
  rather than the colour changing.
*/
const MAP_GROUND = groundMatch ? resolveColour(groundMatch[1]) : '#ffffff'
console.log(`    basemap ground: ${MAP_GROUND}`)
for (const [, name, hex] of swatches) at(hex, MAP_GROUND, AA_GRAPHIC, `${name} pin on the basemap`)

/* -------------------------------------------------------------------------
 * 6. The ground itself.
 * ---------------------------------------------------------------------- */
console.log('\n--- structure ---')


/* --- the material a panel is made of ----------------------------------------- */
//
// There is no contrast floor on a panel's edge here, and that is the change
// worth explaining rather than the assertions themselves.
//
// The edge has been four things: a navy hairline at 1.40:1, invisible; a grey at
// 3.20:1, rejected twice from the same screenshot; white at 16.84:1; a lit teal
// at 5.04:1. Then the panel became glass — a translucent fill over a blurred
// backdrop — and the hairline stopped carrying the job alone.
//
// It is flat now, and deliberately so: an opaque fill one step up from the
// ground, the shared hairline, and one shadow token. The previous version of
// this block asserted that the blur was present, which is asserting a design
// decision rather than a requirement — the requirement is that a card be
// findable against the ground in daylight, and that is what `lift` below pins.
// What this block asserts is that the material is *one* material: nothing
// translucent, nothing blurred, nothing lit, and every panel edged and shadowed
// from the same two tokens, so a screen cannot end up nearly consistent.
{
  /*
    The rule's own definition, not any selector that happens to end in the same
    class. Anchored to a line start and the block's two-space indent, the way
    `declared()` above already does it — without that, an override written
    anywhere earlier in the file (`… ~ * .topbar-lit { padding-top: 0 }`) is
    what gets measured, and the assertions below report a surface with no
    background because they are reading the wrong four lines.
  */
  const rule = (name) => css.match(new RegExp(`\\n  \\.${name}\\s*\\{[^}]*`))?.[0] ?? ''
  const paint = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

  ok(!/backdrop-filter\s*:/.test(paint), 'nothing in the stylesheet blurs what is behind it')
  ok(!/linear-gradient|radial-gradient/.test(paint.replace(/\.wordmark-anim::after\s*\{[^}]*\}/, '')),
     'no surface or control is a gradient (the wordmark\'s one glint excepted)')
  ok(!/::after\s*\{[^}]*height:\s*4\d%/.test(paint), 'no control wears a sheen')

  for (const name of ['card', 'nav-dock', 'topbar-lit']) {
    const r = rule(name)
    ok(r.length > 0, `.${name} exists to be measured`)
    ok(/background:\s*rgb\(var\(--surface\)\);/.test(r), `.${name} is an opaque surface, not an alpha over the ground`)
    ok(/border(-bottom)?:\s*1px solid var\(--hairline\)/.test(r), `.${name} states its edge with the shared hairline`)
  }
  for (const name of ['card', 'nav-dock']) {
    ok(/box-shadow:\s*var\(--shadow-card\)/.test(rule(name)), `.${name} casts the one shared shadow, not its own`)
  }

  /*
    Teal is the accent, not the edge. The selected orb is the one teal thing in
    the navigation: a fill and a ring, so the state is carried by colour and by
    shape and a resting panel carries neither.
  */
  const selected = css.match(/\.nav-dock \.nav-pill\[data-active='true'\][^{]*\{[^}]*/)?.[0] ?? ''
  ok(/background:[^;]*rgb\(var\(--accent\)/.test(selected) && /border-color:[^;]*rgb\(var\(--accent-strong\)/.test(selected),
     'the selected orb is filled and ringed in the accent')
  ok(!/box-shadow/.test(selected), 'and does not glow')
  ok(!/rgb\(var\(--accent\)/.test(rule('card')),
     'a resting panel carries no accent, so selection stays the only teal on the screen')
}

/* -------------------------------------------------------------------------
 * Selection on the light ground.
 *
 * Everything above measures the dark theme; the light one was checked by
 * looking at it, and looking at it is how its selected states came out weaker
 * than the dark theme's on every control. The tinted selected row is 1.1:1
 * from the white row beside it, so the ring has to carry selection — and at
 * 0.45 alpha it measured 2.4:1 against its own face. These read the light
 * block's tokens and hold the same floors the dark theme holds.
 * ---------------------------------------------------------------------- */
console.log('\n--- selection on the light ground ---')
{
  const lightBlock = css.slice(css.indexOf(":root[data-theme='light'] {"))
  const lightVar = (name) => {
    const m = lightBlock.match(new RegExp(`--${name}:\\s*([0-9]+)\\s+([0-9]+)\\s+([0-9]+)\\s*;`))
    if (!m) throw new Error(`light theme variable --${name} not found`)
    return toHex([Number(m[1]), Number(m[2]), Number(m[3])])
  }
  const L = { accent: lightVar('accent'), surface: lightVar('surface'), ink: lightVar('ink') }
  const lightRule = (sel) =>
    (css.match(new RegExp(`:root\\[data-theme='light'\\] ${sel.replace(/[.\[\]'=]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
  const ringAlpha = (rule) => Number(rule.match(/rgb\(var\(--accent\)\s*\/\s*([0-9.]+)\)/)?.[1] ?? 0)
  const faceOf = (rule) => rule.match(/(?:background|--metal-top):\s*(#[0-9a-fA-F]{6})/)?.[1]

  const rowBrand = lightRule('.metal-row-brand')
  const rowFace = faceOf(rowBrand)
  const rowRing = over(L.accent, ringAlpha(rowBrand), rowFace)
  ok(!!rowFace && ringAlpha(rowBrand) > 0, 'the light selected row declares a face and an accent ring')
  ok(ratio(rowRing, rowFace) >= AA_GRAPHIC, 'its ring reads against its own face', ratio(rowRing, rowFace).toFixed(2))
  const rowRest = faceOf(lightRule('.metal-row'))
  ok(ratio(rowFace, rowRest) < 2, 'the two light row faces are too close to carry selection alone, so the ring is load-bearing',
     ratio(rowFace, rowRest).toFixed(2))
  ok(ratio(rowRing, rowRest) >= AA_GRAPHIC, 'and the ring reads against the row beside it', ratio(rowRing, rowRest).toFixed(2))

  const pill = lightRule(".nav-pill[data-active='true']")
  const pillFace = faceOf(pill)
  const pillRing = over(L.accent, ringAlpha(pill), pillFace)
  ok(ratio(pillRing, pillFace) >= AA_GRAPHIC, 'the light side rail marks the current screen with a ring that reads', ratio(pillRing, pillFace).toFixed(2))

  /*
    The theme toggle's chosen tile: accent glyph on an opaque surface tile.
    The first version was a translucent accent tint, and measured here over
    `surface` at 4.54 — but the group sits on `surface-field`, and over that it
    was 3.99 in the light theme. `verify:legibility` caught it in the browser;
    this now measures the opaque tile the component actually paints, and the
    ring against the field the group sits on.
  */
  at(L.accent, L.surface, AA_TEXT, 'the chosen appearance glyph reads on its tile (light)')
  at(T['accent'], T['surface'], AA_TEXT, 'the chosen appearance glyph reads on its tile (dark)')
  const fieldLight = lightVar('surface-field')
  ok(ratio(L.accent, fieldLight) >= AA_GRAPHIC, 'and its accent ring reads against the field the group sits on (light)', ratio(L.accent, fieldLight).toFixed(2))
}

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
