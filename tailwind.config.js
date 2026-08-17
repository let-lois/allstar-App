/** @type {import('tailwindcss').Config} */
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
          DEFAULT: '#0b1220',
          soft: '#1a2436',
          mute: '#5a6b85',
        },
        surface: {
          DEFAULT: '#ffffff',
          sunk: '#f2f5f9',
          raised: '#ffffff',
        },
        brand: {
          50: '#eef4ff',
          100: '#d9e6ff',
          300: '#8fb4ff',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1a3fae',
        },
        outcome: {
          noanswer: '#64748b',
          interested: '#0d9488',
          followup: '#d97706',
          appointment: '#7c3aed',
          quote: '#0284c7',
          notinterested: '#94a3b8',
          sold: '#15803d',
          dnc: '#b91c1c',
        },
      },
      spacing: {
        // Safe-area aware spacing tokens for notch / home-indicator devices.
        safeb: 'env(safe-area-inset-bottom, 0px)',
        safet: 'env(safe-area-inset-top, 0px)',
        // Bottom nav height + home indicator; screens pad by this so nothing hides.
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
        sheet: '20px',
      },
      boxShadow: {
        sheet: '0 -8px 30px rgba(11,18,32,0.16)',
        raise: '0 2px 10px rgba(11,18,32,0.08)',
        float: '0 6px 20px rgba(11,18,32,0.18)',
      },
      fontSize: {
        // Bumped baseline: outdoor sunlight legibility.
        base: ['16px', '24px'],
      },
      transitionDuration: {
        // Deliberately short everywhere — no decorative motion on mid-range Androids.
        DEFAULT: '150ms',
      },
    },
  },
  plugins: [],
}
