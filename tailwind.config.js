/** @type {import('tailwindcss').Config} */

/*
 * Design tokens.
 *
 * White, teal and near-black, with true-grey neutrals. Every value here is a
 * token on purpose: the whole visual system is meant to be changeable from this
 * file, so nothing downstream hard-codes a hex.
 *
 * The teal is split by *job*, not by shade, and the split is measured rather
 * than chosen. Three of the four brand steps cannot legally carry white text:
 *
 *   `brand-400` #20C4D3 — 2.12:1 on white. Decorative fill only: bars, dots.
 *   `brand-500` #0FA9B8 — 2.84:1. The brand accent. Fills, indicators, borders
 *                          on tinted grounds. Never a label colour, never a
 *                          focus ring — it misses even the 3:1 floor WCAG
 *                          1.4.11 sets for a meaningful graphic.
 *   `brand-600` #087F8C — 4.75:1. The *interactive* teal: filled buttons carry
 *                          white labels at AA, and it doubles as teal text and
 *                          as the active icon colour on a tinted pill (4.35:1
 *                          over brand-50).
 *
 * That is why a primary button is 600 and the accent is 500. They look like one
 * colour and behave like two, which is what lets the interface be bright without
 * any of it being unreadable in sunlight.
 *
 * The neutrals are cool greys. An off-white with a warm cast under a cool accent
 * reads as a mistake rather than as a choice.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Mobile-first breakpoints. `xs` exists so we can *add back* affordances that
    // only fit on 375px+, rather than stripping them out going down.
    screens: {
      xs: '375px',
      sm: '430px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
    },
    extend: {
      colors: {
        ink: {
          // 17.7:1 on white. Not pure black — reads warmer and less harsh.
          DEFAULT: '#111827',
          soft: '#334155',
          // 4.76:1 on white, 4.51:1 on the app ground. The lightest tone that
          // may carry text.
          mute: '#64748B',
          // Decorative only — 2.56:1. Dividers, disabled glyphs, placeholder
          // rules. Never text.
          faint: '#94A3B8',
        },
        surface: {
          DEFAULT: '#ffffff',
          /** The app ground: a near-white, so white cards lift off it. */
          sunk: '#F7F9FA',
          /** The faintest teal — active pills, grouped rows, callouts. */
          tint: '#E7F8FA',
          /** Inputs and quiet chips: one step down from the ground. */
          field: '#F1F4F5',
          raised: '#ffffff',
        },
        /**
         * The one border colour. A single hairline everywhere is what stops the
         * interface reading as a grid of boxes — see the note on `.card`.
         */
        line: { DEFAULT: '#E3E8EA', soft: '#EDF1F3' },
        brand: {
          50: '#E7F8FA',
          100: '#D2F1F6',
          200: '#A5E3EC',
          /** Decorative fill — 2.12:1. Bars and dots, never a glyph that matters. */
          400: '#20C4D3',
          /** The brand accent — 2.84:1. Fills and indicators. Not text. */
          500: '#0FA9B8',
          /** Interactive. 4.75:1 with white — labels and icons pass AA. */
          600: '#087F8C',
          700: '#056470',
        },
        /*
         * The logo teal, sampled from the artwork. Now the same value as
         * brand-400: the mark and the interface accent were deliberately
         * separate while the app was orange, and are deliberately the same now
         * that it is not. Kept as its own name so anything that means "the
         * logo's colour" — rather than "the accent" — still says so.
         */
        logo: { DEFAULT: '#07B3CA', ink: '#0A6B7D' },
        // Semantic, and deliberately not orange: a warning that shares the brand
        // hue stops reading as a warning.
        good: { DEFAULT: '#166534', bg: '#E8F5EC' },
        warn: { DEFAULT: '#B45309', bg: '#FEF3E2' },
        bad: { DEFAULT: '#B91C1C', bg: '#FDECEC' },
        info: { DEFAULT: '#1D4ED8', bg: '#E8EEFD' },
        outcome: {
          noanswer: '#64748b',
          interested: '#0d9488',
          followup: '#B45309',
          appointment: '#7c3aed',
          quote: '#0284c7',
          sold: '#166534',
          notinterested: '#94a3b8',
          dnc: '#b91c1c',
        },
      },
      spacing: {
        // Safe-area aware spacing tokens for notch / home-indicator devices.
        safeb: 'env(safe-area-inset-bottom, 0px)',
        safet: 'env(safe-area-inset-top, 0px)',
        navb: 'calc(64px + env(safe-area-inset-bottom, 0px))',
      },
      minHeight: {
        // WCAG 2.5.5 / Apple HIG minimum comfortable target, outdoors-with-gloves.
        tap: '48px',
      },
      minWidth: {
        tap: '48px',
      },
      borderRadius: {
        // One card radius, used everywhere, so nothing looks borrowed.
        card: '22px',
        field: '14px',
        sheet: '26px',
        /** Nav pills, chips, small tappable surfaces. */
        pill: '16px',
      },
      boxShadow: {
        /*
         * Wide, soft and very low alpha. Two layers: a barely-there contact
         * shadow and a broad diffuse one for lift. The failure mode being
         * avoided is a tight dark shadow, which makes a card look stuck onto the
         * page rather than resting on it — and stacked up the screen, reads as a
         * dashboard of widgets.
         */
        card: '0 1px 2px rgba(15,23,42,0.03), 0 4px 16px rgba(15,23,42,0.06)',
        raise: '0 2px 4px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.08)',
        float: '0 4px 10px rgba(15,23,42,0.06), 0 16px 32px rgba(15,23,42,0.10)',
        sheet: '0 -6px 28px rgba(15,23,42,0.12)',
        /** Bottom nav: a hairline, not a drop shadow. */
        nav: '0 -1px 0 rgba(15,23,42,0.05)',
      },
      fontSize: {
        // Bumped baseline: outdoor sunlight legibility.
        base: ['16px', '24px'],
        /** Display sizes for KPI numbers, tuned tight so they read as one unit. */
        kpi: ['30px', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        'kpi-sm': ['24px', { lineHeight: '1.1', letterSpacing: '-0.015em' }],
        title: ['26px', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
      },
      transitionDuration: {
        // Deliberately short everywhere — no decorative motion on mid-range Androids.
        DEFAULT: '150ms',
      },
    },
  },
  plugins: [],
}
