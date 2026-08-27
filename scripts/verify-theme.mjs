import fs from 'node:fs'
import { ratio, parseHex } from './lib/contrast.mjs'

/**
 * The light theme is a whole second interface, and nobody looks at it.
 *
 * That is the entire problem. Every screenshot taken during a change is taken in
 * whichever theme the machine happens to be in, so a light-theme regression is
 * invisible to the person who caused it and shows up on a customer's phone. The
 * dark theme has `verify:contrast`; this is the light theme's.
 *
 * Three classes of failure, all of which happened while building it:
 *
 *   A token declared in one theme and not the other. It does not fall back to
 *   "unset" — it falls back to the *dark* value, so a half-written light theme
 *   is near-black text on a near-black fill, on whichever screen uses that one
 *   token.
 *
 *   A hardcoded face on a control. `.metal-dark` is a navy gradient written as
 *   hex; the label on it is `--ink`, which flips. Navy face, near-black label:
 *   the sign-out button came out genuinely unreadable, and it took a screenshot
 *   to see it.
 *
 *   The pre-paint snippet drifting from the app's own theme module. They are
 *   deliberately duplicated — the snippet has to run before any module exists —
 *   so nothing but a test keeps them agreeing.
 */

const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const themeTs = fs.readFileSync(new URL('../src/lib/theme.ts', import.meta.url), 'utf8')

const fails = []
const checks = []
const ok = (cond, msg, measured) => {
  checks.push(cond)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/** The body of a rule, by its selector. */
function block(selector) {
  const i = css.indexOf(selector)
  if (i < 0) return ''
  const open = css.indexOf('{', i)
  const close = css.indexOf('\n  }', open)
  return css.slice(open, close)
}

const darkBlock = block(':root {')
const lightBlock = block(":root[data-theme='light'] {")

const colourTokens = (b) =>
  new Map([...b.matchAll(/--([a-z0-9-]+):\s*(\d+\s+\d+\s+\d+)\s*;/g)].map((m) => [m[1], m[2]]))

const dark = colourTokens(darkBlock)
const light = colourTokens(lightBlock)

ok(dark.size > 20, `the dark palette parses (${dark.size} colour tokens)`)
ok(light.size > 20, `the light palette parses (${light.size} colour tokens)`)

/* --- 1. parity, by name ------------------------------------------------------ */
{
  const missing = [...dark.keys()].filter((k) => !light.has(k))
  ok(
    missing.length === 0,
    missing.length === 0
      ? 'every colour the dark theme defines, the light theme defines too'
      : `these fall back to their dark values in the light theme: ${missing.join(', ')}`,
  )

  const extra = [...light.keys()].filter((k) => !dark.has(k))
  ok(
    extra.length === 0,
    extra.length === 0
      ? 'and nothing exists only in the light one'
      : `defined only in the light theme, so the dark theme has no value at all: ${extra.join(', ')}`,
  )

  /*
    A token that did not actually change is usually a copy-paste rather than a
    decision. `ink-faint` is the honest exception: it is decorative in both, and
    it happens to land on a tone that works either way.
  */
  const identical = [...dark.keys()].filter((k) => light.get(k) === dark.get(k))
  ok(
    identical.length <= 1,
    `the light theme is a palette rather than a copy (${identical.length} token(s) unchanged: ${identical.join(', ') || 'none'})`,
  )
}

/* --- 2. the light theme is legible ------------------------------------------- */
//
// The same floors `verify:contrast` holds the dark theme to. A light theme is
// where contrast quietly goes wrong, because pale-on-white looks tasteful in a
// mockup and vanishes in a truck windscreen.
{
  const AA = 4.5
  const AA_GRAPHIC = 3
  const hex = (t) => {
    const v = light.get(t)
    if (!v) throw new Error(`--${t} missing from the light theme`)
    return '#' + v.split(/\s+/).map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  }

  const surface = hex('surface')
  const ground = hex('surface-sunk')

  for (const [tone, floor] of [['ink', AA], ['ink-soft', AA], ['ink-mute', AA]]) {
    const r = ratio(parseHex(hex(tone)), parseHex(surface))
    ok(r >= floor, `light: ${tone} is readable on a card`, r.toFixed(2))
  }

  /*
    The teal has to change value between themes, not merely be reused. The bright
    dark-theme teal measures about 2:1 on white — the same role belongs at the
    other end of the ramp, which is exactly why it is a token.
  */
  const accentOnCard = ratio(parseHex(hex('accent')), parseHex(surface))
  ok(accentOnCard >= AA, 'light: the accent can still be text on a card', accentOnCard.toFixed(2))

  for (const tone of ['good', 'warn', 'bad', 'info']) {
    const r = ratio(parseHex(hex(tone)), parseHex(hex(`${tone}-bg`)))
    ok(r >= AA, `light: ${tone} reads on its own background`, r.toFixed(2))
  }

  const lift = ratio(parseHex(surface), parseHex(ground))
  ok(lift >= 1.04 && lift <= 1.35, 'light: a card lifts off the ground without jumping', lift.toFixed(2))

  /*
    Avatar initials are 11px capitals, which is small text and has to clear the
    text floor rather than the graphic one. Fill and ink are separate tokens, so
    a theme override that changed one and forgot the other lands here.
  */
  for (const n of [1, 2, 3, 4]) {
    const r = ratio(parseHex(hex(`tint-${n}-ink`)), parseHex(hex(`tint-${n}-bg`)))
    ok(r >= AA, `light: avatar tint ${n} is legible`, r.toFixed(2))
    const d = ratio(parseHex('#' + dark.get(`tint-${n}-ink`).split(/\s+/).map((x) => Number(x).toString(16).padStart(2, '0')).join('')),
                    parseHex('#' + dark.get(`tint-${n}-bg`).split(/\s+/).map((x) => Number(x).toString(16).padStart(2, '0')).join('')))
    ok(d >= AA_GRAPHIC, `dark: avatar tint ${n} is legible`, d.toFixed(2))
  }
}

/* --- 2b. the palettes that live outside the token block ---------------------- */
//
// Chart ink, the score bar and the drawn map are consumed as inline styles and
// SVG attributes, so they are held as hex tokens rather than channel triplets —
// which means the parity check above, which reads triplets, never saw them.
//
// All three were literal hex inside components until the light theme arrived,
// and all three stayed dark: the score on a Leads row measured 1.52:1 against a
// white card, and the console's trend arrows 1.56:1. Neither was visible to any
// static check; they were found by measuring the rendered page.
{
  const hexIn = (b) => new Map([...b.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map((m) => [m[1], m[2]]))
  const darkHex = hexIn(darkBlock)
  const lightHex = hexIn(lightBlock)

  ok(darkHex.size > 8, `hex-valued tokens parse (${darkHex.size})`)

  const missing = [...darkHex.keys()].filter((k) => !lightHex.has(k))
  ok(
    missing.length === 0,
    missing.length === 0
      ? 'every hex token has a light value too'
      : `hex tokens with no light value, so they stay dark: ${missing.join(', ')}`,
  )

  const AA = 4.5
  const AA_GRAPHIC = 3
  const card = lightHex.get('chart-surface') ?? '#ffffff'

  /* Chart ink is read on the chart's own surface, which is the card. */
  for (const [t, floor] of [['chart-ink', AA], ['chart-ink-2', AA], ['chart-ink-muted', AA], ['chart-good', AA], ['chart-bad', AA]]) {
    const r = ratio(parseHex(lightHex.get(t)), parseHex(card))
    ok(r >= floor, `light: ${t} reads on the chart surface`, r.toFixed(2))
  }

  /*
    The score is a number on a row, so it is text and takes the text floor. The
    bar beside it is a graphic and takes the lower one.
  */
  const surface = '#' + light.get('surface').split(/\s+/).map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  for (const band of ['high', 'mid', 'low']) {
    const ink = ratio(parseHex(lightHex.get(`score-${band}-ink`)), parseHex(surface))
    ok(ink >= AA, `light: the ${band} score reads on a row`, ink.toFixed(2))
    const bar = ratio(parseHex(lightHex.get(`score-${band}`)), parseHex(surface))
    ok(bar >= AA_GRAPHIC, `light: and its bar is findable`, bar.toFixed(2))
  }

  /* The drawn map's grid has to be visible on its own ground, in both themes. */
  for (const [label, pal] of [['light', lightHex], ['dark', darkHex]]) {
    const r = ratio(parseHex(pal.get('map-grid-major')), parseHex(pal.get('map-ground')))
    ok(r >= 1.15, `${label}: the drawn map's grid shows against its ground`, r.toFixed(2))
  }
}

/* --- 3. no control carries one theme's colours into the other ---------------- */
//
// The check that caught the real bug, after two goes at writing it.
//
// A control's face is themed when it comes from a token and hardcoded when it
// does not — hex or `rgba()`, the distinction that matters is `var()`. The first
// version looked only for hex, so it never saw `.metal-dark`, whose face is
// `rgba(255, 255, 255, 0.16)`; it was quietly checking nothing but the overrides
// I had already written.
//
// The face is only half of it. `.metal-dark` also pins `text-white` for the
// login screen's dark ground, and that survives a theme change — so repainting
// the face alone produced a white button with white type on it. A face check
// would have passed that forever.
{
  const rules = [...css.matchAll(/([^\n{}]+)\{([^{}]*?--metal-top:\s*([^;]+);[^{}]*)/g)].map((m) => ({
    selector: m[1].trim().split('\n').pop().trim(),
    body: m[2],
    face: m[3].trim(),
  }))

  const base = rules.filter((r) => !r.selector.startsWith(':root[data-theme='))
  const overrides = new Set(
    rules.filter((r) => r.selector.startsWith(':root[data-theme=')).map((r) => r.selector.replace(/^:root\[data-theme='light'\]\s*/, '')),
  )

  ok(base.length > 0, `controls that declare a face (${base.length})`)

  const hardcoded = base.filter((r) => !r.face.includes('var('))
  ok(hardcoded.length > 0, `and how many hardcode it rather than reading a token (${hardcoded.length})`)

  /*
    Saturated faces are exempt by name rather than by rule. A red or green button
    carries white type on either ground and means the same thing in both.
  */
  const SATURATED = new Set(['.metal-brand', '.metal-danger', '.metal-success'])

  const unthemed = hardcoded.filter((r) => !SATURATED.has(r.selector) && !overrides.has(r.selector))
  ok(
    unthemed.length === 0,
    unthemed.length === 0
      ? 'every neutral face is restated for the light theme'
      : `these keep one theme's face in the other: ${unthemed.map((r) => r.selector).join(', ')}`,
  )

  /*
    And where the base rule pins a literal text colour, the override has to
    restate that too — otherwise the type stays put while the face moves out
    from under it.
  */
  const pinnedInk = hardcoded.filter((r) => /@apply[^;]*\btext-(white|black)\b/.test(r.body))
  ok(pinnedInk.length > 0, `faces that also pin a literal text colour (${pinnedInk.map((r) => r.selector).join(', ') || 'none'})`)

  for (const r of pinnedInk) {
    if (SATURATED.has(r.selector)) continue
    const override = rules.find(
      (o) => o.selector === `:root[data-theme='light'] ${r.selector}`,
    )
    ok(
      !!override && /(^|;|\s)color:/.test(override.body),
      `${r.selector}'s light override moves the label as well as the face`,
    )
  }
}

/* --- 3b. and no surface paints itself dark either ---------------------------- */
//
// The hole the first two versions left, found the way the others were: from a
// screenshot of the light theme with three unreadable screens on it.
//
// Checks 3 above read `--metal-top` declarations. `.metal-row` does not have
// one — it paints itself with `background: linear-gradient(#143240, #0e2430)`
// directly — so it was never in the list at all. It is the face under Stages,
// under the "Go to" list on More and under every collapsible header, which is
// most of the surfaces a rep actually taps.
//
// So this asks the broader question: does any component rule hardcode a colour
// it paints itself with, and is that rule restated for the other theme. A rule
// that reaches for a token needs no override; one that writes a hex does.
{
  const rules = [...css.matchAll(/([^\n{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim().split('\n').pop().trim(), body: m[2] }))
    .filter((r) => /^[.:]/.test(r.selector))

  /* Comments carry prose about colours; strip them before reading any as paint. */
  const paint = (body) => body.replace(/\/\*[\s\S]*?\*\//g, ' ')

  const hardcoded = rules.filter(
    (r) =>
      !r.selector.startsWith(':root[data-theme=') &&
      /(^|[;\s])background(-color|-image)?:[^;]*#[0-9a-fA-F]{3,8}/.test(paint(r.body)),
  )
  ok(hardcoded.length > 0, `surfaces that paint themselves a fixed colour (${hardcoded.map((r) => r.selector).join(', ')})`)

  const overridden = new Set(
    rules
      .filter((r) => r.selector.startsWith(":root[data-theme='light']"))
      .map((r) => r.selector.replace(/^:root\[data-theme='light'\]\s*/, '')),
  )

  const unthemed = hardcoded.filter((r) => !overridden.has(r.selector))
  ok(
    unthemed.length === 0,
    unthemed.length === 0
      ? 'and each of them is repainted for the light theme'
      : `these stay dark under light-theme text: ${unthemed.map((r) => r.selector).join(', ')}`,
  )
}

/* --- 4. the pre-paint snippet still agrees with the app ---------------------- */
//
// Duplicated on purpose: the snippet runs before any module exists, which is the
// whole point of it. Nothing but this keeps the two saying the same thing.
{
  const key = themeTs.match(/THEME_KEY = '([^']+)'/)?.[1]
  ok(!!key, `the app names its storage key (${key})`)
  ok(html.includes(`'${key}'`), 'and the pre-paint snippet reads that same key', key)

  ok(
    /prefers-color-scheme: light/.test(html) && /prefers-color-scheme: light/.test(themeTs),
    'both resolve "system" through the same media query',
  )

  /*
    The snippet has to set the attribute the stylesheet keys off. A snippet that
    stored a preference and set nothing would leave every cold start dark.
  */
  ok(/setAttribute\('data-theme'/.test(html), 'the snippet applies the theme before first paint')

  /*
    Two grounds now, so the pre-paint background has to have a light case too.
    Pinned to the dark value it is a dark flash on every cold start of the light
    theme — the same bug that block was written to prevent, only harder to see.
  */
  const lightGround = '#' + light.get('surface-sunk').split(/\s+/).map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  ok(
    new RegExp(`html\\[data-theme='light'\\]\\s*\\{\\s*background:\\s*${lightGround}`, 'i').test(html),
    'the pre-paint background has a light case, and it is the light ground',
    lightGround,
  )
  ok(
    new RegExp(`content="${lightGround}"`, 'i').test(html) || /theme-color/.test(themeTs),
    'and the browser chrome follows the theme rather than staying pinned',
  )
}

console.log(
  fails.length
    ? `\n${fails.length} of ${checks.length} theme check(s) failed`
    : `\n=== both themes hold up (${checks.length} checks) ===`,
)
process.exit(fails.length ? 1 : 0)
