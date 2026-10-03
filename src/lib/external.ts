/**
 * Handing a call, a text or an email to the phone's own apps.
 *
 * In a browser a `tel:`, `sms:` or `mailto:` link needs nothing from us: the
 * browser follows the href and the OS takes over. Inside the phone app it used
 * to rely on the same thing — the link navigated the webview, the shell's
 * navigation policy caught it and passed it to `Linking.openURL`. That path had
 * two faults. It depended on WKWebView turning a tap into a navigation request
 * for a scheme it cannot load, and every failure on the way was swallowed, so a
 * rep whose tap went nowhere was told nothing at all.
 *
 * So the shell now offers a direct call, `window.__allstarShell.openExternal`,
 * installed by `apps/mobile/src/components/allstar-web.tsx` from a native action.
 * It opens the URL with React Native's Linking and answers whether the phone
 * managed it, which is what lets the screen say "We couldn't open this" instead
 * of doing nothing.
 *
 * Outside the shell there is no such object and the caller lets the browser
 * follow the link as it always has.
 */

export interface ShellBridge {
  /** Resolves `{ ok: false }` when the phone had nothing that could open it. */
  openExternal?: (url: string) => Promise<{ ok: boolean }>
  /**
   * The phone's own speech recognition, for note dictation. See `lib/speech.ts`.
   *
   * Present only in app builds that carry the native module (build 9 on);
   * results come back as `allstar-dictation` window events.
   */
  dictation?: {
    start: (opts: { lang: string }) => Promise<{ ok: boolean; error?: string }>
    stop: () => Promise<void>
  }
}

/** What the native recogniser reports, delivered as an `allstar-dictation` window event. */
export type ShellDictationEvent =
  | { type: 'result'; transcript: string; isFinal: boolean }
  | { type: 'error'; error: string }
  | { type: 'end' }

declare global {
  interface Window {
    __allstarShell?: ShellBridge
  }
}

/** The phone app's hand-off, when this page is running inside it. */
export function shellOpener(): ShellBridge['openExternal'] | undefined {
  return typeof window !== 'undefined' ? window.__allstarShell?.openExternal : undefined
}

/** What a person is told when the phone would not open the app for them. */
export const COULD_NOT_OPEN = 'We couldn’t open this action on your device.'

/**
 * Open a `tel:`, `sms:` or `mailto:` link.
 *
 * Returns true when it was handed off (or, in a browser, left to the browser),
 * false when the phone said it could not. Never throws: the detail goes to the
 * console for whoever is debugging, and the caller shows a sentence.
 */
export async function openExternal(url: string): Promise<boolean> {
  const native = shellOpener()
  if (native) {
    try {
      const res = await native(url)
      if (!res?.ok) console.warn('[external] the phone could not open', url.split(':')[0])
      return !!res?.ok
    } catch (err) {
      console.warn('[external] hand-off failed', url.split(':')[0], err)
      return false
    }
  }
  // A browser: a top-level navigation to one of these schemes hands off to the
  // OS without unloading the page.
  window.location.href = url
  return true
}
