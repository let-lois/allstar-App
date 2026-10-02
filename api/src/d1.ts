/**
 * D1 binds at most 100 parameters per statement.
 *
 * Not SQLite's limit — SQLite allows 32,766, which is why every one of these
 * queries passed against a local database and then failed in production the
 * first time somebody selected, imported or drew round a hundred leads. The
 * error came back as a plain 500, "Something went wrong", at roughly 97 to 100
 * rows depending on how many shared parameters (`?1` client id, `?2`, …) the
 * statement also binds.
 *
 * So a statement that binds `fixed` shared parameters plus one per item gets
 * at most `100 - fixed` items. Placeholders are numbered (`?N`), and the
 * highest number used is what counts.
 */
export const D1_MAX_PARAMS = 100

export function bindChunks<T>(xs: readonly T[], fixed: number, perItem = 1): T[][] {
  const size = Math.max(1, Math.floor((D1_MAX_PARAMS - fixed) / perItem))
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}
