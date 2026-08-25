/**
 * Colour-vision maths for the chart palette.
 *
 * This lives in the repo rather than being run out of a tool somewhere, and that
 * is the whole point. The last set of colour-blindness figures in
 * `charts/tokens.ts` came from a validator that was not here; the theme moved to
 * a dark ground, the contrast figures were re-measured because the means to do
 * that *was* in the repo, and the CVD figures were left inherited and marked as
 * such. A number nobody can re-derive goes stale the first time somebody edits
 * the thing it describes.
 *
 * The transforms are the standard ones, and the CVD simulation is
 * Machado, Oliveira & Fernandes (2009) at severity 1.0 — named because the
 * thresholds are calibrated to *that* model. Swapping in a different simulation
 * moves borderline pairs and would need the thresholds recalibrated; it is part
 * of the standard, not an implementation detail.
 */

/** Machado-Oliveira-Fernandes (2009), severity 1.0, in linear RGB. */
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
}

const hexToSrgb = (h) => {
  const s = h.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`not a six-digit hex colour: ${h}`)
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255)
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linear = (hex) => hexToSrgb(hex).map(toLinear)

function oklabFromLinear([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** OKLCH lightness and chroma. Hue is not needed by any check here. */
export function oklch(hex) {
  const [L, a, b] = oklabFromLinear(linear(hex))
  return { L, C: Math.hypot(a, b) }
}

/** Hue angle in degrees, for asserting a ramp really is one hue. */
export function okhue(hex) {
  const [, a, b] = oklabFromLinear(linear(hex))
  return (((Math.atan2(b, a) * 180) / Math.PI) % 360 + 360) % 360
}

function simulate(hex, kind) {
  const [r, g, b] = linear(hex)
  const M = MACHADO[kind]
  const clamp = (c) => Math.max(0, Math.min(1, c))
  return [
    clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b),
  ]
}

/**
 * Euclidean distance in OKLab, ×100.
 *
 * `kind` omitted measures unsimulated vision — the companion floor that stops a
 * pair being "colour-blind safe" while full-colour readers cannot tell it apart
 * either.
 */
export function deltaE(a, b, kind) {
  const x = oklabFromLinear(kind ? simulate(a, kind) : linear(a))
  const y = oklabFromLinear(kind ? simulate(b, kind) : linear(b))
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/**
 * The worst adjacent pair under protanopia and deuteranopia.
 *
 * Adjacent rather than all pairs because the charts these colours serve are
 * lines, bars and stacks, where only neighbours touch and assignment never
 * skips a slot. A scatter or a choropleth would need every pair, and would cap
 * how many series it can carry.
 */
export function worstAdjacent(palette, kind) {
  let worst = Infinity
  let pair = null
  for (let i = 1; i < palette.length; i++) {
    const d = kind
      ? Math.min(deltaE(palette[i - 1], palette[i], 'protan'), deltaE(palette[i - 1], palette[i], 'deutan'))
      : deltaE(palette[i - 1], palette[i])
    if (d < worst) {
      worst = d
      pair = [palette[i - 1], palette[i]]
    }
  }
  return { worst, pair }
}

/** The thresholds, named so a gate reads as the standard rather than as magic. */
export const CVD_TARGET = 8.0
export const NORMAL_FLOOR = 15.0
export const CHROMA_FLOOR = 0.1
export const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] }
export const ORDINAL_MIN_DL = 0.06
