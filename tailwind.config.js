/** @type {import('tailwindcss').Config} */

/*
 * Design tokens.
 *
 * The palette is warm orange on near-white, and the shades are picked against
 * measured contrast rather than by eye. Two of them matter enough to record why:
 *
 * `brand-400` (#FF8A3D) is the brand orange — warm, energetic, and only 2.35:1
 * against white. It is a **fill**: bars, dots, icon glyphs, active indicators.
 * It can never carry white label text, and it is not strong enough to be a focus
 * ring either (WCAG 1.4.11 wants 3:1 for a UI component).
 *
 * `brand-600` (#C2410C) is the same hue family taken deep enough to be a
 * **surface**: 5.18:1 with white, so a button label passes AA at any size, and it
 * doubles as orange text on white. Splitting the accent into "fill" and "surface"
 * is what lets the interface look bright without any of it being unreadable.
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
          // 4.76:1 on white, 4.46:1 on the app background. The lightest tone
          // that may carry text.
          mute: '#64748B',
          // Decorative only — 2.56:1. Dividers, disabled glyphs, placeholder
          // rules. Never text.
          faint: '#94A3B8',
        },
        surface: {
          DEFAULT: '#ffffff',
          /** The app ground: off-white with a warm cast, so white cards lift off it. */
          sunk: '#FAF7F4',
          /** Secondary surface — cream, for grouped rows and quiet callouts. */
          warm: '#FFF4EC',
          /** Inputs: a hair of warmth so a field reads as recessed, not as a card. */
          field: '#F6F2EE',
          raised: '#ffffff',
        },
        brand: {
          50: '#FFF4EC',
          100: '#FFE6D5',
          200: '#FFCFAE',
          /** Fill only. 2.35:1 — no text on this, no focus rings. */
          400: '#FF8A3D',
          500: '#F26419',
          /** Surface and text. 5.18:1 with white — labels pass AA at any size. */
          600: '#C2410C',
          700: '#9A3412',
        },
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
        card: '20px',
        field: '14px',
        sheet: '24px',
      },
      boxShadow: {
        /*
         * Two-layer and low-alpha: a tight shadow for the edge and a wide, very
         * soft one for lift. A single heavy shadow is what makes a card look
         * stuck on rather than resting on the page.
         */
        card: '0 1px 2px rgba(17,24,39,0.04), 0 6px 16px -8px rgba(17,24,39,0.10)',
        raise: '0 1px 2px rgba(17,24,39,0.05), 0 8px 20px -10px rgba(17,24,39,0.14)',
        float: '0 2px 6px rgba(17,24,39,0.06), 0 16px 32px -12px rgba(17,24,39,0.22)',
        sheet: '0 -8px 30px rgba(17,24,39,0.14)',
        /** Bottom nav: a hairline lift, not a drop shadow. */
        nav: '0 -1px 0 rgba(17,24,39,0.06), 0 -8px 24px -16px rgba(17,24,39,0.18)',
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
