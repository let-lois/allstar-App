/**
 * Where a badge's QR code points.
 *
 * Not the company's website: the homeowner's question is "is this person who
 * they say they are", and a marketing page cannot answer it. The code opens
 * the public verification page for that badge, which shows the name, photo,
 * company and whether the badge is still good — and links to the website if
 * the company set one.
 *
 * The origin is the running one by default, which is right on every web
 * deployment with no configuration. `VITE_PUBLIC_ORIGIN` exists for the one
 * case where it is wrong: inside a native shell the page is served from
 * `capacitor://localhost` or `http://localhost`, and a QR code encoding that
 * is a code no homeowner's camera can open. Every badge would carry one, and
 * nothing on screen would look wrong.
 *
 * Set it to the public address of the web app when packaging. Unset, this is
 * exactly what it was.
 */
const PUBLIC_ORIGIN =
  (process.env.EXPO_PUBLIC_ORIGIN as string | undefined)?.replace(/\/$/, '') || undefined

/**
 * Where this app lives on the open web, for telling somebody where to go.
 *
 * Exported because the badge's QR code is no longer the only thing that needs
 * it: inside the native shell the More screen has to name the address of the
 * admin console, which does not exist in that bundle. Same constant, same
 * reason — `window.location.origin` in the shell is a `file://` path that is
 * useless to a person.
 */
export const publicOrigin = (): string => PUBLIC_ORIGIN ?? window.location.origin

export const verifyUrl = (badgeId: string): string =>
  `${PUBLIC_ORIGIN ?? window.location.origin}/verify/${badgeId}`

/** The badge id inside a verification path, or null. */
export function badgeIdFromPath(pathname: string): string | null {
  const m = /^\/verify\/([1-9]\d{7})\/?$/.exec(pathname)
  return m ? m[1]! : null
}
