/**
 * Moved to `@allstar/core`.
 *
 * This file stays as a re-export so the 24 files that import
 * `../data/outcomes` do not all have to change in the same commit as the
 * extraction. The logic is identical — it simply lives somewhere the React
 * Native app can reach it, in a package that compiles with no DOM library at
 * all. Call sites migrate to `@allstar/core/outcomes` as their screens are
 * touched; when the last one does, this file goes.
 */
export * from '@allstar/core/outcomes'
