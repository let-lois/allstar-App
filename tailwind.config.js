/** @type {import('tailwindcss').Config} */

/*
 * Design tokens.
 *
 * Teal on near-black, with cool-grey neutrals. Every value here is a token on
 * purpose: the whole visual system is meant to be changeable from this file and
 * `index.css`, so nothing downstream hard-codes a hex.
 *
 * Two kinds of colour live here, and the difference is the important part.
 *
 * **Semantic roles** — ink, surface, line, accent, status — are CSS variables.
 * They describe a job ("the quietest legible text", "the ground everything
 * stands on") and take their value from the theme in `index.css`. Moving to a
 * dark ground is not a matter of darkening greys; it is the same roles pointing
 * somewhere else, which is why a call site never says slate-500.
 *
 * **Saturated fills** — the brand ramp, the logo, outcome colours — stay
 * literal. A filled teal button specifies both its own face and its own label,
 * so it measures the same wherever it lands and has nothing to theme.
 *
 * The teal is split by *job*, not by shade, and the split is measured rather
 * than chosen — with `scripts/lib/contrast.mjs`, whose figures are pinned by
 * `npm run verify:contrast`.
 *
 *   `brand-400` #20C4D3 — decorative fill: bars, dots, map pins.
 *   `brand-500` #0FA9B8 — the brand accent. Fills, indicators, borders.
 *   `brand-600` #087F8C — filled interactive teal; white labels pass AA on it.
 *
 * Teal *writing* is a separate token, `accent`, because the readable teal
 * inverts with the ground: dark (#087F8C) on white, bright (#20C4D3) on this.
 * A step number cannot express that; a role can.
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
        /*
         * Semantic colours are CSS variables, not hexes.
         *
         * The app runs on a near-black ground, and a theme is not a set of
         * darker greys — it is the same *roles* pointing at different values.
         * Naming the role here and the value in `index.css` is what lets
         * `text-ink-mute` mean "the quietest legible text on whatever this
         * screen stands on" rather than "slate 500". Every value below was
         * measured with `scripts/lib/contrast.mjs`, not picked.
         *
         * The channels are space-separated so Tailwind's `<alpha-value>` still
         * works: `bg-ink/15` composites correctly against the dark ground.
         */
        ink: {
          /** 15.5:1 on a card. The page's primary text. */
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          /** 11.0:1. Secondary text, and the floor on any machined face. */
          soft: 'rgb(var(--ink-soft) / <alpha-value>)',
          /** 6.5:1 on a card. The quietest tone that may carry body text. */
          mute: 'rgb(var(--ink-mute) / <alpha-value>)',
          /** 3.5:1 — decorative. Dividers, placeholders, disabled glyphs. */
          faint: 'rgb(var(--ink-faint) / <alpha-value>)',
        },
        surface: {
          /** A card: one step up from the ground, so it lifts without a shadow. */
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          /** The app ground. Everything else is measured against this. */
          sunk: 'rgb(var(--surface-sunk) / <alpha-value>)',
          /** The faintest teal — active pills, grouped rows, callouts. */
          tint: 'rgb(var(--surface-tint) / <alpha-value>)',
          /** Inputs: recessed by being darker than the card, not by a bevel. */
          field: 'rgb(var(--surface-field) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
        },
        /**
         * The hairline, and only the hairline.
         *
         * `line` is the hairline: dividers inside a surface, chart axes, edges
         * that are seams rather than outlines.
         *
         * A panel's edge is not here at all any more. It is drawn from
         * `--accent` at `--lit-edge` by `.card`, because it is a lit teal rather
         * than a flat colour — a border, a gradient and a bloom together — and
         * a single hex in a colour table cannot describe that.
         */
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          soft: 'rgb(var(--line-soft) / <alpha-value>)',
        },
        /*
         * Teal *as text*, which is a different problem from teal as a fill.
         *
         * On a white ground the readable teal is dark (#087F8C, 4.75:1); on this
         * one it is bright (#20C4D3, 7.94:1 on a card). Same role, opposite end
         * of the ramp — which is exactly why it cannot be a step number. Call
         * sites that mean "teal writing" say `text-accent` and stay correct on
         * either ground.
         */
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          /** The brighter step, for glyphs on a machined teal face. 7.2:1 there. */
          strong: 'rgb(var(--accent-strong) / <alpha-value>)',
        },
        brand: {
          /*
           * The saturated ramp stays literal, because a filled teal button
           * carries its own label: `bg-brand-600 text-white` measures 4.75:1
           * wherever it lands, and the shape reads at 3.9:1 against the ground.
           * A fill that specifies both of its own colours does not need a theme.
           *
           * The light tints moved out: what used to be `bg-brand-50` is now
           * `bg-surface-tint`, since "the faintest teal ground" has to darken
           * with everything else and a step called 50 cannot.
           */
          /** Decorative fill — bars and dots. 8.75:1 as a shape on the ground. */
          400: '#20C4D3',
          /** The brand accent. Fills, indicators, borders. */
          500: '#0FA9B8',
          /** Filled interactive teal. White labels pass AA on it. */
          600: '#087F8C',
          700: '#056470',
        },
        /*
         * The logo teal, sampled from the artwork. Kept as its own name so
         * anything that means "the logo's colour" — rather than "the accent" —
         * still says so.
         */
        logo: { DEFAULT: '#07B3CA', ink: '#0A6B7D' },
        /*
         * Semantic status, themed for the same reason the neutrals are: the
         * light-ground greens and reds measure 2.4-3.4:1 on a dark card, which
         * is a status nobody can read.
         */
        good: {
          DEFAULT: 'rgb(var(--good) / <alpha-value>)',
          bg: 'rgb(var(--good-bg) / <alpha-value>)',
        },
        warn: {
          DEFAULT: 'rgb(var(--warn) / <alpha-value>)',
          bg: 'rgb(var(--warn-bg) / <alpha-value>)',
        },
        bad: {
          DEFAULT: 'rgb(var(--bad) / <alpha-value>)',
          bg: 'rgb(var(--bad-bg) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--info) / <alpha-value>)',
          bg: 'rgb(var(--info-bg) / <alpha-value>)',
        },
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
        /*
         * One card radius, used everywhere, so nothing looks borrowed.
         *
         * Opened up across the board. A tighter radius reads as a box with
         * rounded corners; a generous one reads as a shape, which is most of
         * what separates a polished interface from a competent one. CSS has no
         * continuous corner, so the nearest honest approximation is a larger
         * radius and a softer shadow under it.
         */
        card: '26px',
        field: '16px',
        sheet: '30px',
        /** Nav pills, chips, small tappable surfaces. */
        pill: '18px',
      },
      boxShadow: {
        /*
         * Wide, soft, and much deeper than they were on white.
         *
         * A 6%-alpha shadow is invisible on a near-black ground — there is
         * nothing darker for it to be — so these carry roughly five times the
         * alpha they used to. The failure mode being avoided is unchanged: a
         * tight dark shadow makes a card look stuck onto the page rather than
         * resting on it, and stacked up the screen reads as a dashboard of
         * widgets. What actually separates a card here is its hairline and its
         * one-pixel lit top edge; these only keep the corners from looking cut
         * out.
         *
         * The nav hairline inverts outright: a dark line above a dark bar is
         * nothing, so it is now a faint light one.
         */
        card: '0 1px 2px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.28)',
        raise: '0 2px 6px rgba(0,0,0,0.45), 0 12px 32px rgba(0,0,0,0.35)',
        float: '0 6px 14px rgba(0,0,0,0.5), 0 20px 44px rgba(0,0,0,0.45)',
        sheet: '0 -8px 34px rgba(0,0,0,0.55)',
        /** Bottom nav: a hairline, not a drop shadow. */
        nav: '0 -1px 0 rgba(255,255,255,0.07)',
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
