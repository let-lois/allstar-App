/**
 * Whether the webview may be opened in a desktop inspector.
 *
 * On iOS this becomes `WKWebView.inspectable`
 * (`react-native-webview/apple/RNCWebViewImpl.m:571`), which since iOS 16.4
 * defaults to off and is the only thing standing between Safari's Web
 * Inspector and the page. On Android the same prop reaches
 * `WebView.setWebContentsDebuggingEnabled`, which is what `chrome://inspect`
 * needs.
 *
 * Expo's DOM wrapper sets it to `__DEV__` and nothing else
 * (`expo/src/dom/webview-wrapper.tsx:117`). That is right for a store build and
 * wrong for an internal one: a preview build that renders a blank page has no
 * inspector, no console — `RNCWebChromeClient` drops those outside `DEBUG` too
 * — and therefore no way at all to say what happened. Three Android preview
 * builds were undiagnosable for exactly that reason. The wrapper spreads the
 * caller's `dom` props *after* its own defaults, so this decision is ours to
 * make.
 *
 * ## Why it is not simply `!isProduction`
 *
 * An inspectable webview is a real exposure, not a cosmetic flag: anyone with
 * the app and a Mac can read the DOM, the network, and IndexedDB — which is
 * where this app keeps the session token and every lead the rep has touched.
 * So the rule is closed by default and opens only for a channel we recognise
 * as ours. An unknown channel, a missing one, a build with updates not
 * configured: all closed. Getting it wrong in that direction costs a build;
 * getting it wrong in the other direction ships it.
 *
 * Pure, and kept out of the route so a Node gate can drive every case without a
 * phone, the same way `handoff.ts` is.
 */

/** The EAS channels that are ours, from `eas.json`'s `build` profiles. */
const INTERNAL = new Set(['development', 'preview'])

/**
 * @param dev `__DEV__` — a Metro-served build, which is already a development
 *   machine talking to a device it owns.
 * @param channel `Updates.channel`, the EAS channel the build was made for, or
 *   `null` when updates are not configured.
 */
export function isInspectable(dev: boolean, channel: string | null | undefined): boolean {
  if (dev) return true
  return typeof channel === 'string' && INTERNAL.has(channel.trim().toLowerCase())
}
