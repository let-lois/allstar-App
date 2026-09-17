/// <reference types="vite/client" />

/**
 * `process.env`, as the two bundlers hand it over.
 *
 * The app reads its build-time configuration from `process.env.EXPO_PUBLIC_*`
 * rather than Vite's `import.meta.env.VITE_*`, because Metro — which bundles
 * the native app and the DOM component inside it — cannot parse `import.meta`
 * at all, so a module using it does not merely misbehave under Metro, it fails
 * to build. `process.env.EXPO_PUBLIC_*` is the one spelling both inline
 * statically: Metro natively, Vite via `define` in `vite.config.ts`.
 *
 * Written out rather than inherited, and deliberately narrower than Node's.
 *
 * @types/node is in fact present in the workspace — the Expo install pulls it
 * in transitively, and TypeScript includes it automatically — so without this
 * declaration every file in `src/` would type-check against the whole Node
 * standard library, in an app that has no Node under it. This shadows that
 * with exactly what the two bundlers actually substitute and nothing else, so
 * `process.cwd()` in a browser file is a compile error rather than a runtime
 * one. Checked, not assumed: a probe file using `process.cwd()` under `src/`
 * is rejected against this type.
 *
 * The `VITE_*` names are still what anyone sets, in `.env.local` or on the
 * Cloudflare Pages project — see `.env.example`. Only the reading moved.
 */
declare const process: {
  env: {
    NODE_ENV?: 'development' | 'production'
    EXPO_PUBLIC_API_URL?: string
    EXPO_PUBLIC_MAPTILER_KEY?: string
    EXPO_PUBLIC_GOOGLE_MAPS_KEY?: string
    EXPO_PUBLIC_GOOGLE_MAP_ID?: string
  }
}
