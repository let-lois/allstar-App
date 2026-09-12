/**
 * Where a badge's QR code points.
 *
 * Not the company's website: the homeowner's question is "is this person who
 * they say they are", and a marketing page cannot answer it. The code opens
 * the public verification page for that badge, which shows the name, photo,
 * company and whether the badge is still good — and links to the website if
 * the company set one. Built from the app's own origin, so it is right on
 * every deployment without configuration.
 */
export const verifyUrl = (badgeId: string): string => `${window.location.origin}/verify/${badgeId}`

/** The badge id inside a verification path, or null. */
export function badgeIdFromPath(pathname: string): string | null {
  const m = /^\/verify\/([1-9]\d{7})\/?$/.exec(pathname)
  return m ? m[1]! : null
}
