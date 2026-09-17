/**
 * The retry budget both outboxes spend.
 *
 * Mutations and photos queue separately and drain separately, for reasons set
 * out in `photos.ts` — but they give up on the same terms, and each file used
 * to say so in its own copy of these two lines. The comment in `photos.ts`
 * read "Same budget as the mutation outbox", which was true and unenforceable:
 * nothing made it stay true. Now it is one declaration, and the claim is the
 * code.
 */

/** Eight tries, then a person decides. */
export const MAX_ATTEMPTS = 8

/**
 * Exponential backoff, capped at a minute — a rep in a basement should not
 * hammer the radio, and a server having a bad afternoon should not be asked
 * about it every second.
 */
export const backoffMs = (attempts: number): number =>
  Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6))
