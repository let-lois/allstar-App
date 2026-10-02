import { ApiError } from './http'

/**
 * What to tell a person when something they did failed.
 *
 * The server's own sentence when it sent one — "That rep is not on this team"
 * is something to act on — and otherwise the screen's fallback. When the
 * server failed outright it also sent a reference (the request id), and that
 * goes on the end: "Import failed. Reference: ERR-7f3a91c2". The person reads
 * one line; an administrator finds the rest under that reference in Settings →
 * Activity log → Errors, or in the Worker's log.
 *
 * Twenty-seven screens did `err instanceof ApiError ? err.message : '…'`, which
 * printed the server's bare "Something went wrong." and dropped the reference
 * the server had sent with it.
 */
export function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const generic = /^something went wrong\.?$/i.test(err.message.trim())
    const text = generic ? fallback : err.message
    return err.reference ? `${text} Reference: ${formatReference(err.reference)}` : text
  }
  return fallback
}

/** ERR- and the server's request id, as shown and as searched. */
export function formatReference(id: string): string {
  return `ERR-${id.toUpperCase()}`
}
