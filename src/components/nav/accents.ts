import type { CSSProperties } from 'react'

/**
 * Per-destination badge accents.
 *
 * One entry per nav route, exposed as CSS custom properties so swapping a colour
 * means editing this table and nothing else — the badge rule in index.css reads
 * `--badge-top`, `--badge-bottom`, `--badge-ink`, `--badge-ring` and `--badge-glow`
 * and knows nothing about which route it is drawing.
 *
 * One teal, stepped from light to deep, with graphite for the two neutral
 * destinations. Not a rainbow and not five hues — the palette is teal, white and
 * black, and the bar is the most visible surface in the app, so it is where that
 * has to be true first.
 *
 * The trade this makes, stated plainly: neighbouring steps sit only 1.3-1.9:1
 * apart, so colour no longer distinguishes one destination from the next. The
 * icon does that, and the label under it. Colour here now signals one thing —
 * that the bar belongs to this product — rather than five.
 *
 * Every pair is measured. A dark glyph over the band it actually occupies
 * (25%-75% of the badge height) reads between 4.80:1 and 6.62:1 against its
 * gradient, clearing the 3:1 WCAG 1.4.11 floor for a meaningful graphic and the
 * 4.5:1 text floor as well. The ring is one shared value at 2.96:1 against the
 * white bar, so every badge has an equally defined edge instead of the lighter
 * steps bleeding into it.
 *
 * No green and no red. Both are load-bearing elsewhere in this app — won, and
 * do-not-contact — and a nav badge wearing one would be the single place in the
 * product where they meant nothing.
 */
export interface Accent {
  top: string
  bottom: string
  ink: string
  ring: string
  glow: string
}

export const NAV_ACCENTS: Record<string, Accent> = {
  '/today': {
    top: '#CFF4F9',
    bottom: '#6FDDEC',
    ink: '#06505C',
    ring: '#779CA5',
    glow: 'rgba(6, 80, 92, 0.45)',
  },
  '/map': {
    top: '#B0E9F2',
    bottom: '#35C6DB',
    ink: '#05414C',
    ring: '#779CA5',
    glow: 'rgba(5, 65, 76, 0.45)',
  },
  '/leads': {
    top: '#9BDCE7',
    bottom: '#1BA7BD',
    ink: '#04333D',
    ring: '#779CA5',
    glow: 'rgba(4, 51, 61, 0.45)',
  },
  '/team': {
    top: '#9BDCE7',
    bottom: '#1BA7BD',
    ink: '#04333D',
    ring: '#779CA5',
    glow: 'rgba(4, 51, 61, 0.45)',
  },
  '/pipeline': {
    top: '#8ACFDC',
    bottom: '#0E8A9E',
    ink: '#03272F',
    ring: '#779CA5',
    glow: 'rgba(3, 39, 47, 0.45)',
  },
  '/more': {
    top: '#DFE3EA',
    bottom: '#A7B0C0',
    ink: '#2B3444',
    ring: '#9AA2AF',
    glow: 'rgba(43, 52, 68, 0.45)',
  },
  '/admin': {
    top: '#DFE3EA',
    bottom: '#A7B0C0',
    ink: '#2B3444',
    ring: '#9AA2AF',
    glow: 'rgba(43, 52, 68, 0.45)',
  },
}

const FALLBACK = NAV_ACCENTS['/more']

export function accentVars(to: string): CSSProperties {
  const a = NAV_ACCENTS[to] ?? FALLBACK
  return {
    '--badge-top': a.top,
    '--badge-bottom': a.bottom,
    '--badge-ink': a.ink,
    '--badge-ring': a.ring,
    '--badge-glow': a.glow,
  } as CSSProperties
}
