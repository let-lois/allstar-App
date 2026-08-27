/**
 * WCAG relative luminance and contrast, plus alpha compositing.
 *
 * Separate from the gates that use it because the palette work and the
 * verification both need the same arithmetic, and two copies of a contrast
 * formula is two chances to be subtly wrong about the one thing this app cannot
 * afford to be wrong about: whether a rep can read the screen outdoors.
 */

export function parseHex(hex) {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

export function toHex(rgb) {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

/** Composite a colour with alpha over an opaque backdrop. */
export function over(fg, alpha, bg) {
  const f = typeof fg === 'string' ? parseHex(fg) : fg
  const b = typeof bg === 'string' ? parseHex(bg) : bg
  return f.map((c, i) => c * alpha + b[i] * (1 - alpha))
}

export function luminance(color) {
  const rgb = typeof color === 'string' ? parseHex(color) : color
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export const ratio = (a, b) => Math.round(contrast(a, b) * 100) / 100

/**
 * Follow one `var()` hop to the hex it names in the theme.
 *
 * Colours that are consumed by inline styles and SVG attributes — chart ink, the
 * drawn map's ground — are held as hex-valued custom properties so they can
 * follow the theme. Read straight out of a `.ts` file they arrive as the string
 * "var(--chart-surface)", and every measurement taken against one becomes NaN.
 *
 * NaN is the dangerous part rather than the inconvenience: it fails every
 * comparison, so a gate that forgets to resolve does not report a wrong number,
 * it reports a wrong *verdict*. Moving the chart palette onto tokens sent 21
 * checks in `verify:contrast` and 10 in `verify:charts` to NaN in one commit.
 *
 * Lives here so there is one of it. Two gates had already grown their own copy
 * before this was written, which is the same shape of problem as the palettes
 * this whole exercise was about.
 *
 * Reads the first `:root` block, which is the dark theme. Light values sit
 * further down the file and belong to `verify:theme`.
 */
export function resolveThemeColour(value, css) {
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(String(value).trim())
  if (!m) return value
  const hit = css.match(new RegExp(`--${m[1]}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`))
  if (!hit) throw new Error(`--${m[1]} is not a hex-valued token in index.css`)
  return hit[1]
}
