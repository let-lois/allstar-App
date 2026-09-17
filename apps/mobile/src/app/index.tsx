/**
 * The app, as it exists today, on a phone.
 *
 * A route file cannot itself be a DOM component — `'use dom'` marks a whole
 * module as web code, and Expo Router needs this one to be native — so the
 * shell is imported rather than declared here. That split is the rule, not a
 * preference.
 */
import { StyleSheet, View } from 'react-native'

import AllStarWeb from '@/components/allstar-web'
import type { ApiRequest, ApiResponse } from '@/lib/api-bridge'

/** Content types whose bytes will not survive being read as text. */
const BINARY = /^(image|video|audio|application\/(octet-stream|pdf|zip))/i

/**
 * One API request, made from the native side.
 *
 * This exists because of where the webview is loaded from. Expo hands a DOM
 * component to WKWebView with `loadFileURL`, so the page's origin is
 * `file://`, and a cross-origin request from there carries `Origin: null`. The
 * Worker echoes CORS headers only for an origin on its allowlist, so it
 * answers with none, the browser drops the response, and every screen reports
 * a network problem — signing in first.
 *
 * React Native's `fetch` is not a browser: there is no origin and no CORS
 * check. So the webview hands the request over here, and the only thing the
 * web app notices is that its own `fetch` returned normally.
 *
 * A native action is asynchronous and carries only serialisable values, which
 * is why the contract in `api-bridge.ts` is strings. Binary responses — photo
 * bytes — are base64'd; text is passed through, since base64 on every JSON
 * response would be waste on the hot path.
 */
async function apiFetch(req: ApiRequest): Promise<ApiResponse> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  })

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  const isBinary = BINARY.test(headers['content-type'] ?? '')
  let body: string
  if (isBinary) {
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let raw = ''
    /*
      Chunked rather than one spread. `String.fromCharCode(...bytes)` on a
      photo blows the argument limit and throws a range error, which would look
      like a broken photo rather than a broken loop.
    */
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      raw += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    body = btoa(raw)
  } else {
    body = await res.text()
  }

  return { status: res.status, statusText: res.statusText, headers, body, isBase64: isBinary }
}

export default function Index() {
  return (
    <View style={styles.fill}>
      <AllStarWeb
        apiFetch={apiFetch}
        dom={{
          /*
            The web app draws its own scrolling regions and its own safe-area
            padding — it is a mobile-first PWA that reps already run full-screen
            from the home screen. Letting the webview add a second scroll
            container on top gives the rubber-banding-inside-rubber-banding feel
            that makes a wrapped website obvious.
          */
          scrollEnabled: false,
          contentInsetAdjustmentBehavior: 'never',
          /*
            Location, which the webview will not ask for on its own. Without
            this WKWebView denies `navigator.geolocation` with no prompt, so
            the route cannot order itself from where the rep is standing and a
            tapped house has no position to compare against — the app looks
            broken rather than unpermitted. The Info.plist string that the
            system prompt shows is in app.json.
          */
          geolocationEnabled: true,
          mediaPlaybackRequiresUserAction: false,
          style: styles.fill,
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({ fill: { flex: 1 } })
