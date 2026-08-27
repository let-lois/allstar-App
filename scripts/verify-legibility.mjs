import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Every word on every screen, measured against what is actually painted behind
 * it, in both themes.
 *
 * The static gates read the stylesheet. This one reads the page, and it exists
 * because the stylesheet is not where the failures were. A light theme shipped
 * with `verify:theme` at 50 green checks still had:
 *
 *   the lead score at 1.52:1 on a white row — hex inside `StatusPill`
 *   the console's trend arrows at 1.56:1 — hex inside the chart tokens
 *   "Demo — sample data" at 2.29:1 — a decorative tone carrying a real sentence
 *   every teal label on the page ground at 4.24:1 — a palette tuned against a
 *     card, which is the easier of the two backgrounds
 *
 * None of those is visible to a check that reads tokens, because none of them is
 * wrong in the token. They are wrong where the colour lands.
 *
 * It walks the DOM for leaf elements with text, finds the nearest ancestor that
 * actually paints an opaque background, and measures. Leaf-only because a
 * container's text colour is inherited by children and would be counted twice;
 * nearest-opaque because the app is built from translucent glass over glass and
 * the immediate parent is usually `rgba(0,0,0,0)`.
 *
 * 4.5:1 throughout rather than the large-text allowance of 3:1. This is a phone
 * held at arm's length in a truck, and the type is small.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const FLOOR = 4.5

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/**
 * Measure every word against what is painted behind it.
 *
 * A real function handed to `page.evaluate`, not a string. The first version was
 * a template literal, and a template literal eats backslashes: `\d` became `d`
 * and `\(` became `(`, so the colour parser was matching on `/[d.]+/g` and every
 * measurement in this file was arithmetic on NaN. NaN fails every comparison, so
 * the gate reported that all twelve screens were clear — in the same run where a
 * probe printed the offending rows as dark grey under near-black text.
 *
 * It is the whole reason this gate exists, arrived at from the wrong side: a
 * check that reads the page is worth nothing if the reading is wrong, and a
 * green run is exactly what a broken reading looks like.
 */
function probe(floor) {
  const lin = (c) => {
    c /= 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const ratio = (a, b) => {
    const [x, y] = [L(a), L(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
  }
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value)
    if (!m) return null
    const parts = m[1].split(',').map((n) => parseFloat(n))
    if (parts.slice(0, 3).some(Number.isNaN)) return null
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 }
  }

  /*
    What is actually behind this text, composited.

    Not "the nearest opaque ancestor". This interface is built from glass over
    glass — a card is 72% opaque, the chip on the map 80% — so an
    opacity threshold picks an arbitrary layer and measures against the wrong
    one. An earlier draft used 85% and skipped both, then reported the map badge
    as unreadable after it had been given exactly the plate it needed.

    So: collect every painting layer up to the first fully opaque one, then blend
    them back down in order. Gradients are averaged across their stops, because a
    two-stop vertical gradient behind a line of text is close enough to its mean
    and the alternative is sampling pixels.
  */
  const layers = (el) => {
    const stack = []
    let n = el
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const stops = (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(parse).filter(Boolean)
        if (stops.length) {
          stack.push({
            rgb: [0, 1, 2].map((i) => stops.reduce((t, c) => t + c.rgb[i], 0) / stops.length),
            a: stops.reduce((t, c) => t + c.a, 0) / stops.length,
          })
        }
      }
      const c = parse(cs.backgroundColor)
      if (c && c.a > 0) {
        stack.push(c)
        if (c.a >= 0.999) break
      }
      n = n.parentElement
    }
    const root = parse(getComputedStyle(document.documentElement).backgroundColor)
    let base = stack.length && stack[stack.length - 1].a >= 0.999
      ? stack.pop().rgb
      : (root && root.a >= 0.999 ? root.rgb : [255, 255, 255])
    // Blend back down: the deepest layer first, the one nearest the text last.
    for (let i = stack.length - 1; i >= 0; i--) {
      const { rgb, a } = stack[i]
      base = [0, 1, 2].map((k) => rgb[k] * a + base[k] * (1 - a))
    }
    return base
  }

  const out = []
  for (const el of document.querySelectorAll('body *')) {
    // Leaves only: a container's colour is inherited, so counting it as well
    // would report the same text twice under two different names.
    if (el.children.length) continue

    /*
      SVG text is out of scope, and deliberately rather than because it is
      awkward. A map label sits on a marker circle that is its *sibling*, so
      walking ancestors finds the map container and measures the label against a
      colour that is nowhere near it — it reported the cluster counts at 1.05:1
      while they are white on a dark teal pin.

      Pins and their labels are measured by `verify:contrast`, which knows the
      basemap ground and the swatch each pin is filled with. This gate owns the
      DOM.
    */
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue
    const text = (el.textContent || '').trim()
    if (!text || text.length > 60) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue
    const fg = parse(cs.color)
    if (!fg) continue
    const c = ratio(fg.rgb, layers(el))
    if (!Number.isFinite(c)) {
      // Never silently skip an unreadable measurement — that is the failure this
      // whole file was written after.
      out.push({ t: text.slice(0, 30), r: 'unmeasurable' })
      continue
    }
    if (c < floor) out.push({ t: text.slice(0, 30), r: Number(c.toFixed(2)) })
  }
  return out
}

const ROUTES = [
  ['today', '/today'], ['leads', '/leads'], ['pipeline', '/pipeline'],
  ['map', '/map'], ['route', '/route'], ['more', '/more'], ['team', '/team'],
  ['standings', '/standings'], ['dashboard', '/admin'], ['reports', '/admin/reports'],
  ['settings', '/admin/settings'],
]

const browser = await chromium.launch({ executablePath: chromiumPath() })

for (const scheme of ['light', 'dark']) {
  console.log(`\n--- ${scheme} ---`)
  /*
    Forced through `colorScheme` rather than trusting the machine. Whichever
    theme this runner happens to sit in is the one theme that would get checked,
    which is exactly how a light-theme regression reaches a customer.
  */
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
  })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)

  const applied = await page.evaluate(() => document.documentElement.dataset.theme)
  ok(applied === scheme, `${scheme}: the app really is in the theme being measured`, applied)

  const report = (name, found) =>
    ok(
      found.length === 0,
      `${scheme}: every word on ${name} clears ${FLOOR}:1`,
      found.length ? found.slice(0, 4).map((f) => `"${f.t}" ${f.r}`).join(', ') : undefined,
    )

  report('the sign-in screen', await page.evaluate(probe, FLOOR))

  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.waitForTimeout(900)
  await page.getByRole('button').filter({ hasText: /Platform overview/ }).first().click()
  await page.waitForTimeout(1700)
  await dismissTour(page)

  for (const [name, path] of ROUTES) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1100)
    report(name, await page.evaluate(probe, FLOOR))
  }
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} legibility check(s) failed` : '\n=== every word is legible in both themes ===')
process.exit(fails.length ? 1 : 0)
