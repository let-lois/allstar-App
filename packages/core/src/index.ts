/**
 * The whole package, for consumers that would rather import once.
 *
 * Deep imports work too — `@allstar/core/day` resolves to `src/day.ts` — and
 * are what the web app uses, because a shim that re-exports one module should
 * not drag in twenty.
 */
export * from './address'
export * from './basemap'
export * from './contact'
export * from './csv'
export * from './day'
export * from './deals'
export * from './format'
export * from './geo'
export * from './glyphs'
export * from './id'
export * from './leadFilter'
export * from './leadLists'
export * from './leaderboard'
export * from './outcomes'
export * from './qr'
export * from './roles'
export * from './route'
export * from './seed'
export * from './settings'
export * from './types'
export * from './walkthrough'
