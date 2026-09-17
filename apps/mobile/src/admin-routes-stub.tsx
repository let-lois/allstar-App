/**
 * The admin console, absent.
 *
 * Metro swaps this in for the web app's `src/adminRoutes.tsx` when bundling
 * the DOM shell — see `metro.config.js`. The console is desktop software: wide
 * tables, a territory lasso, a CSV importer, 8,575 lines of it. It is
 * role-gated to managers and above, nobody opens it on a phone, and the help
 * centre films it on a desktop for that reason.
 *
 * Returning nothing is therefore correct rather than a limitation. The routes
 * do not exist in the native app, and `App.tsx`'s catch-all already sends an
 * unknown path to `/today`, so a stray `/admin` link lands somewhere sensible
 * instead of on a blank screen.
 *
 * It also removes the last dynamic `import()` from the DOM bundle. Metro
 * follows one into a chunk rather than leaving it to be fetched later, and
 * `expo export` could not serialise the shared chunk that eleven of them
 * produced.
 */
export function adminRoutes() {
  return null
}
