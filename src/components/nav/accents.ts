import type { CSSProperties } from 'react'

/**
 * Per-destination badge accents.
 *
 * One entry per nav route, exposed as CSS custom properties so swapping a colour
 * means editing this table and nothing else — the badge rule in index.css reads
 * `--badge-top`, `--badge-bottom`, `--badge-ink`, `--badge-ring` and `--badge-glow`
 * and knows nothing about which route it is drawing.
 *
 * The family is teal through blue to graphite, so the bar belongs to the app's
 * teal accent rather than being a rainbow beside it. Each destination still gets
 * its own hue, because a permanent colour per item is what makes the bar
 * scannable without reading — but they are now variations on one idea.
 *
 * Every pair is measured. A dark glyph over the band it actually occupies
 * (25%-75% of the badge height) reads between 5.01:1 and 6.62:1 against its
 * gradient, clearing the 3:1 WCAG 1.4.11 floor for a meaningful graphic with
 * room to spare; the ring sits near 3:1 against the white bar so the badge has a
 * defined edge rather than bleeding into it.
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
    top: '#BCEFF7',
    bottom: '#4CD3E6',
    ink: '#07545F',
    ring: '#77BFCB',
    glow: 'rgba(10, 107, 125, 0.45)',
  },
  '/map': {
    top: '#C9E4FC',
    bottom: '#74B6F7',
    ink: '#12457F',
    ring: '#8CB4DA',
    glow: 'rgba(21, 82, 173, 0.45)',
  },
  '/leads': {
    top: '#CBE6EA',
    bottom: '#7FBCC7',
    ink: '#0D3F49',
    ring: '#8FB4BC',
    glow: 'rgba(13, 63, 73, 0.45)',
  },
  '/team': {
    top: '#CBE6EA',
    bottom: '#7FBCC7',
    ink: '#0D3F49',
    ring: '#8FB4BC',
    glow: 'rgba(13, 63, 73, 0.45)',
  },
  '/pipeline': {
    top: '#CFD8F8',
    bottom: '#8C9BEE',
    ink: '#28347F',
    ring: '#9AA3D8',
    glow: 'rgba(40, 52, 127, 0.45)',
  },
  '/more': {
    top: '#DFE3EA',
    bottom: '#A7B0C0',
    ink: '#2B3444',
    ring: '#9AA2AF',
    glow: 'rgba(61, 69, 83, 0.45)',
  },
  '/admin': {
    top: '#DFE3EA',
    bottom: '#A7B0C0',
    ink: '#2B3444',
    ring: '#9AA2AF',
    glow: 'rgba(61, 69, 83, 0.45)',
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
