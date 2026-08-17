/**
 * Client-generated IDs. Records are created offline and must be addressable
 * immediately, so the client owns the identity and the server adopts it.
 */
export function uid(prefix = 'id'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}
