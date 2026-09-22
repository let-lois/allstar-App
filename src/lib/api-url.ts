/**
 * Where the API lives.
 *
 * Overridable at build time so a local dev server can point at `wrangler dev`.
 * The default is the deployed Worker, which is what a Pages build should use.
 *
 * Its own module, deliberately tiny and dependency-free: the map's tile URLs
 * need the address and nothing else, and the gates import that module into
 * Node, where `http.ts`'s class fields do not parse under strip-only TypeScript.
 */
export const API_URL: string =
  (process.env.EXPO_PUBLIC_API_URL as string | undefined)?.replace(/\/$/, '') ||
  'https://allstar-api.josh-af6.workers.dev'
