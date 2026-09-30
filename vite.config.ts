import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  /*
    Build-time configuration, substituted at the point it is read.

    The app reads `process.env.EXPO_PUBLIC_*` instead of
    `import.meta.env.VITE_*`, because Metro cannot parse `import.meta`. The
    `VITE_*` names in `.env.local` and on the Cloudflare Pages project do not
    change; this is the translation.

    **An unset value becomes the identifier `undefined`, not `''`, and that is
    deliberate.** Every read is written `(process.env.X as string | undefined)
    ?.trim() || ''`, so `undefined` lets the optional chain short-circuit and
    the whole expression folds to `''` at build time. With no Google Maps key
    that makes `gmapsConfigured()` provably false, and rollup then drops
    `GoogleFieldMap.tsx`, `supercluster`, `kdbush` and `fast-equals` — 45 kB
    that a rep on cellular would otherwise download and never run. Substituting
    `''` instead leaves `''.trim()`, which terser will not evaluate, and the
    map code ships. Measured, not guessed.

    `loadEnv`'s `''` prefix reads every name in the file rather than only the
    `VITE_`-prefixed ones, which is why the third argument is there. The
    directory is `'.'` because `vite build` runs from the project root and the
    narrow `process` declaration in `src/vite-env.d.ts` has no `cwd()`.
  */
  const env = loadEnv(mode, '.', '')
  const pass = (name: string) => {
    const value = env[`VITE_${name}`]
    return value ? JSON.stringify(value) : 'undefined'
  }

  return {
  plugins: [react()],
  define: {
    /*
      Always `undefined` for a Vite build: this identifies the Expo DOM shell,
      and a Vite build is by definition not it. Metro substitutes the real
      value. Declared here rather than left out because an undefined
      `process.env.X` is a runtime error in a browser, not a falsy read.
    */
    'process.env.EXPO_DOM_HOST_OS': 'undefined',
    'process.env.EXPO_PUBLIC_API_URL': pass('API_URL'),
    /*
      The one name that is not a straight `EXPO_PUBLIC_<X>` / `VITE_<X>` pair:
      the variable people set is `VITE_PUBLIC_ORIGIN` (see .env.example), and
      `EXPO_PUBLIC_PUBLIC_ORIGIN` would be a silly thing to type. Spelled out
      rather than bent through `pass()`.
    */
    'process.env.EXPO_PUBLIC_ORIGIN': pass('PUBLIC_ORIGIN'),
    'process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY': pass('GOOGLE_MAPS_KEY'),
    'process.env.EXPO_PUBLIC_GOOGLE_MAP_ID': pass('GOOGLE_MAP_ID'),
    'process.env.EXPO_PUBLIC_HELP_URL': pass('HELP_URL'),
  },
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    // Field reps are on cellular. Split the admin/desktop-only weight out of the
    // field-rep critical path so the phone bundle stays small.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          // Routing changes far more often than the runtime; keeping it separate
          // means a routing-only deploy doesn't invalidate the big React chunk
          // in a rep's cache.
          if (id.includes('react-router') || id.includes('@remix-run')) return 'router'
          return 'vendor'
        },
      },
    },
  },
  }
})
