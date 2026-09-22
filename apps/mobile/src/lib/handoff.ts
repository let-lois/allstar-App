/**
 * Where a URL the webview wants to navigate to should actually go.
 *
 * The shell allows nothing but its own page to navigate the webview — a
 * `target="_blank"` inside a webview loads *in place*, which is how the app
 * once became Google Maps with no way back but force-quitting. Everything
 * else is handed off, and there are four honest destinations:
 *
 *   **shell**       the shell's own page: `file://` in a build, `about:blank`
 *                   during set-up, and the dev server under `expo start`
 *                   (WKWebView asks about the first load too, and refusing it
 *                   opened the app as a Safari sheet over an empty webview).
 *
 *   **directions**  `maps.apple.com` and `google.com/maps` go to the OS so the
 *                   real Maps app opens with the route — the whole point of the
 *                   Navigate button is the app with the voice.
 *
 *   **system**      anything that is not `http(s)` at all — `tel:`, `sms:`,
 *                   `mailto:`. These are not pages. The in-app browser only
 *                   opens web content, so handing it `tel:+15125550100` opened
 *                   nothing: Call, Text and Email on every lead did nothing on a
 *                   phone, silently, on both platforms. The OS knows what to do
 *                   with them and `Linking.openURL` asks it.
 *
 *   **browser**     every other `http(s)` link — Street View, a badge page —
 *                   opens in the in-app browser, one Done button away from
 *                   where the rep was.
 *
 * Pure, and kept apart from the route that uses it so a Node gate can drive
 * every case without a phone (`scripts/verify-handoff.mjs`), the way the API
 * bridge is tested.
 */

export type Destination = 'shell' | 'directions' | 'system' | 'browser'

// Terminated after the host or path so `maps.apple.com.evil.example`, which
// anybody can register, is a web page and not a route handed to Maps.
const DIRECTIONS = /^https:\/\/(maps\.apple\.com|(?:www\.)?google\.[a-z.]+\/maps)(?:[/?#]|$)/i
const WEB = /^https?:\/\//i

/**
 * @param devServerOrigin the dev server's origin (`http://192.168.1.20:8081`)
 *   while developing, or `null` in a build. Compared with a trailing slash so
 *   `http://192.168.1.20:8081.evil.example` is not the dev server.
 */
export function destinationFor(url: string, devServerOrigin: string | null): Destination {
  if (url.startsWith('file://') || url.startsWith('about:')) return 'shell'
  if (devServerOrigin && url.startsWith(devServerOrigin + '/')) return 'shell'
  if (DIRECTIONS.test(url)) return 'directions'
  if (!WEB.test(url)) return 'system'
  return 'browser'
}
