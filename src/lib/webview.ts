/**
 * In-app browser detection.
 *
 * Reps get onboarded by a link in a text, a Messenger thread or an email. Tapping
 * that link opens an *embedded* webview, not the real browser — and embedded
 * webviews silently deny camera, microphone and often geolocation, with no
 * permission prompt at all. The app looks broken through no fault of the rep's.
 *
 * There's no feature test for this: you can't ask "will the mic prompt appear?"
 * without trying to use it. So this is user-agent sniffing, which is normally a
 * bad idea, and is the correct tool here — a false positive costs a dismissible
 * banner, a false negative costs a rep who thinks the product doesn't work.
 */

export type Platform = 'android' | 'ios' | 'other'

export interface InAppBrowser {
  isInApp: boolean
  /** Human-readable host app, when we can name it. */
  app?: string
  platform: Platform
}

/**
 * Signature → the app the rep is actually inside. Order matters: Messenger's UA
 * also carries Facebook's `FB_IAB` token, so the specific match has to come
 * first or every Messenger rep is told they're in Facebook.
 */
const SIGNATURES: { test: RegExp; app: string }[] = [
  { test: /Messenger|MessengerForiOS|FB_IAB\/MESSENGER/i, app: 'Messenger' },
  { test: /FBAN|FBAV|FB_IAB|FBIOS/i, app: 'Facebook' },
  { test: /Instagram/i, app: 'Instagram' },
  { test: /LinkedInApp/i, app: 'LinkedIn' },
  { test: /Twitter|TwitterAndroid/i, app: 'X' },
  { test: /Snapchat/i, app: 'Snapchat' },
  { test: /TikTok|BytedanceWebview|musical_ly/i, app: 'TikTok' },
  { test: /Line\//i, app: 'LINE' },
  { test: /GSA\//i, app: 'Google app' },
]

export function platformOf(ua = navigator.userAgent): Platform {
  if (/Android/i.test(ua)) return 'android'
  // iPadOS 13+ reports as Macintosh; the touch check separates it from a real Mac.
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return 'ios'
  return 'other'
}

export function detectInAppBrowser(): InAppBrowser {
  const ua = navigator.userAgent
  const platform = platformOf(ua)

  for (const { test, app } of SIGNATURES) {
    if (test.test(ua)) return { isInApp: true, app, platform }
  }

  // Generic Android WebView. `; wv)` is the documented marker Chrome adds when
  // it's running embedded rather than as the browser.
  if (platform === 'android' && /;\s*wv\)/i.test(ua)) {
    return { isInApp: true, platform }
  }

  // iOS: every browser is WebKit, so the tell is the absence of a known browser
  // token in a Safari-shaped UA.
  if (platform === 'ios' && /AppleWebKit/i.test(ua) && !/Safari/i.test(ua)) {
    return { isInApp: true, platform }
  }

  return { isInApp: false, platform }
}

/**
 * Android can hand a URL to Chrome directly via an intent URL. There's no iOS
 * equivalent that works reliably from inside a webview, so callers fall back to
 * copying the link.
 */
export function openInChromeAndroid(): void {
  const { host, pathname, search } = window.location
  window.location.href = `intent://${host}${pathname}${search}#Intent;scheme=https;package=com.android.chrome;end`
}

export async function copyCurrentUrl(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(window.location.href)
    return true
  } catch {
    return false
  }
}
