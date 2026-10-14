/**
 * The app, as it exists today, on a phone.
 *
 * A route file cannot itself be a DOM component — `'use dom'` marks a whole
 * module as web code, and Expo Router needs this one to be native — so the
 * shell is imported rather than declared here. That split is the rule, not a
 * preference.
 */
import * as Linking from 'expo-linking'
import * as Updates from 'expo-updates'
import * as WebBrowser from 'expo-web-browser'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { AppState, BackHandler, Platform, StyleSheet, View } from 'react-native'
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import AllStarWeb, { type AllStarWebRef } from '@/components/allstar-web'
import type { ApiRequest, ApiResponse } from '@/lib/api-bridge'
import { contactUrlFor, destinationFor } from '@/lib/handoff'
import { HAS_NATIVE_DICTATION, dictationStart, dictationStop, forwardDictationEvents } from '@/lib/dictation'
import { isInspectable } from '@/lib/inspectable'
import { shouldApply, shouldCheck, type OtaMoment } from '@/lib/ota'

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
  /*
    A binary request body, decoded back to bytes.

    A photo upload is a `Blob`, which cannot cross a JSON bridge, so the web
    side base64s it — see `encodeBody` in api-bridge.ts. React Native's `fetch`
    takes a typed array as a body and sends it as-is, which is what the
    Worker's `POST /api/photos/:id` expects: raw bytes with the image's own
    content type, not a multipart form.
  */
  const requestBody =
    req.body != null && req.isBase64
      ? Uint8Array.from(atob(req.body), (c) => c.charCodeAt(0))
      : req.body

  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: requestBody,
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

/**
 * A link that leaves the app.
 *
 * Which way it leaves is decided in `lib/handoff.ts`, which has the reasoning
 * and a gate. In short: directions open the real Maps app; `tel:`, `sms:` and
 * `mailto:` go to the OS, which is the only thing that can open them — the
 * in-app browser cannot, and handing it `tel:` is how Call, Text and Email on
 * every lead did nothing on a phone; every other web link opens in the in-app
 * browser, one Done button away from where the rep was.
 *
 * `openURL` can reject when no app claims the URL. For a web link the in-app
 * browser is the fallback rather than a dead tap. For a system link there is
 * nothing to fall back to: a phone with no dialler is a tablet, and the tap
 * ends there rather than in a browser tab that cannot help either.
 */
function handOff(url: string): void {
  switch (destinationFor(url, DEV_SERVER_ORIGIN)) {
    case 'directions':
      void Linking.openURL(url).catch(() => WebBrowser.openBrowserAsync(url))
      return
    case 'system':
      void Linking.openURL(url).catch(() => {})
      return
    case 'browser':
      void WebBrowser.openBrowserAsync(url)
      return
    case 'shell':
      return
  }
}

/**
 * Call, Text and Email, asked for by the web app directly.
 *
 * A native action rather than a link the webview navigates, because the answer
 * matters: `Linking.openURL` rejects when nothing on the phone can open the URL
 * (no Mail account, a simulator with no Phone app), and the screen needs to know
 * that to say so. The navigation route above still catches a plain link, but it
 * can only guess and stay silent.
 *
 * `canOpenURL` is deliberately not the check. On iOS it answers false for any
 * scheme not listed in the binary's `LSApplicationQueriesSchemes` — a native
 * build change, not something an update can fix — so trusting it would refuse
 * working calls. The rejection from `openURL` is the honest signal.
 *
 * Only the three contact schemes are accepted; anything else is refused.
 */
async function openExternal(url: string): Promise<{ ok: boolean }> {
  const target = contactUrlFor(url, Platform.OS)
  if (!target) return { ok: false }
  try {
    await Linking.openURL(target)
    return { ok: true }
  } catch (err) {
    // The detail stays here, for a developer; the person is told a sentence.
    console.warn('[shell] could not open', target.split(':')[0], err)
    return { ok: false }
  }
}

/**
 * Where the shell's own page comes from while developing.
 *
 * A built app loads the DOM component from `file://`. A dev server does not:
 * Expo serves it from `http://<host>:8081/_expo/@dom/...` (see
 * `expo/src/dom/base.ts`), and WKWebView asks `onShouldStartLoadWithRequest`
 * about the very first load, not only about links. So the gate below refused
 * the shell's own page on iOS under `expo start`, handed it to
 * `WebBrowser.openBrowserAsync`, and the app opened as a Safari sheet over an
 * empty webview. Android never asked, which is why only iOS showed it.
 *
 * Read the same way Expo reads it rather than assumed to be localhost: on a
 * phone the dev server is the laptop's LAN address, and a tunnel is another
 * host again. `__DEV__` only, so a production build keeps the strict rule.
 */
const DEV_SERVER_ORIGIN: string | null = __DEV__
  ? (() => {
      try {
        const getDevServer =
          require('react-native/Libraries/Core/Devtools/getDevServer').default
        return new URL(getDevServer().url).origin
      } catch {
        return null
      }
    })()
  : null

/**
 * Whether Safari's Web Inspector and `chrome://inspect` can see the page.
 *
 * Read once, at module scope, because it cannot change while the app runs. The
 * reasoning — and why this is not simply "not production" — is in
 * `lib/inspectable.ts`. `Updates.channel` is `null` when updates are not
 * configured, which that function treats as closed.
 */
const WEBVIEW_INSPECTABLE = isInspectable(__DEV__, Updates.channel)

/**
 * A store build is every build that is not one of ours — the same rule, the
 * other way round. The web app hides its testing aids (the demo, "Simulate no
 * signal") there; TestFlight and preview builds keep them.
 */
const STORE_BUILD = !WEBVIEW_INSPECTABLE

/**
 * `file://` is the shell. Nothing else navigates this webview.
 *
 * `about:` is allowed because a webview issues `about:blank` on its own during
 * set-up, and refusing it would fight the host rather than the app. The dev
 * server is allowed in development only, for the reason above.
 */
function onShouldStartLoadWithRequest(req: ShouldStartLoadRequest): boolean {
  if (destinationFor(req.url, DEV_SERVER_ORIGIN) === 'shell') return true
  handOff(req.url)
  return false
}

/**
 * Fetch and, when the moment allows, apply a newer update — the rule and its
 * reasons are in `lib/ota.ts`. Failure is silent by design: no network means
 * the rep keeps the update they have, which is exactly what they had before.
 */
async function refreshUpdate(moment: OtaMoment) {
  if (!shouldCheck(Updates.isEnabled, __DEV__, moment)) return
  try {
    const found = await Updates.checkForUpdateAsync()
    if (!found.isAvailable) return
    const fetched = await Updates.fetchUpdateAsync()
    if (fetched.isNew && shouldApply(moment)) await Updates.reloadAsync()
  } catch {
    // Offline, or expo-updates already mid-check on its own: try again next time.
  }
}

export default function Index() {
  const shell = useRef<AllStarWebRef>(null)
  /*
    The status bar and the gesture/navigation bar, measured by the phone.

    Android only. Since Android 15/16 every app draws edge to edge, and
    Android's webview often reports `env(safe-area-inset-*)` as 0 — so the
    header slid under the status bar and the bottom dock under the gesture
    bar. The web app takes the larger of `env()` and these (`--safe-top`,
    `--safe-bottom` in index.css). iOS's webview already reports the real
    values, so it is left exactly as it was.
  */
  const safe = useSafeAreaInsets()
  const insetTop = Math.round(safe.top)
  const insetBottom = Math.round(safe.bottom)
  // Memoised: a new object every render would re-send the props to the webview.
  const insets = useMemo(
    () => (Platform.OS === 'android' ? { top: insetTop, bottom: insetBottom } : undefined),
    [insetTop, insetBottom],
  )
  /*
    In a ref rather than state, and read inside the handler rather than closed
    over. The back handler is registered once; state would either re-register
    it on every navigation or capture a stale value and exit the app from the
    third screen of a lead form.
  */
  const canGoBack = useRef(false)

  /*
    Stable, because it is a native action: the wrapper marshals function props
    by identity and emits a `$$props` message whenever they change, which
    re-renders the DOM root. A fresh closure each render would do that on every
    render of this route.
  */
  const onCanGoBack = useCallback(async (can: boolean) => {
    canGoBack.current = can
  }, [])

  /*
    Android's back button. The web app runs under `MemoryRouter`, so pressing
    back reached the native stack — which has one route — and closed the app,
    taking a half-typed lead with it.

    Returning `true` consumes the press; `false` lets Android do what it would
    have done, which at the app's own home screen is exit, and that is correct.
    `BackHandler` is a no-op on iOS, which has no such button.
  */
  /*
    The latest update on reopen, not two cold starts later: see `lib/ota.ts`.
  */
  useEffect(() => {
    void refreshUpdate({ kind: 'launch' })
    let leftAt: number | null = null
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') leftAt = Date.now()
      else if (state === 'active' && leftAt != null) {
        const awayMs = Date.now() - leftAt
        leftAt = null
        void refreshUpdate({ kind: 'foreground', awayMs })
      }
    })
    return () => sub.remove()
  }, [])

  // The phone's speech results, to the note being dictated. See `lib/dictation.ts`.
  useEffect(() => forwardDictationEvents((event) => shell.current?.dictationEvent(JSON.stringify(event))), [])

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack.current) return false
      shell.current?.goBack()
      return true
    })
    return () => sub.remove()
  }, [])

  return (
    <View style={styles.fill}>
      <AllStarWeb
        ref={shell}
        apiFetch={apiFetch}
        openExternal={openExternal}
        onCanGoBack={onCanGoBack}
        dictationStart={HAS_NATIVE_DICTATION ? dictationStart : undefined}
        dictationStop={HAS_NATIVE_DICTATION ? dictationStop : undefined}
        storeBuild={STORE_BUILD}
        insets={insets}
        dom={{
          /*
            `react-native-webview`, not Expo's own `@expo/dom-webview`, which is
            the default. This one prop decides more about whether the app works
            than anything else in this file, so here is the whole reason.

            `@expo/dom-webview` installs **no `WebChromeClient`** on Android
            (see its `DomWebView.kt`, which sets `javaScriptEnabled` and the two
            file-access flags and nothing more). Four things follow, and all four
            are silent:

              - `settings.domStorageEnabled` is never set, and Android's
                documented default is `false`. So `localStorage` **and**
                IndexedDB are off — and this app is offline-first, reads every
                screen out of IndexedDB, and keeps the session token there. It
                falls back to `db.ts`'s in-memory store, so a rep is signed out
                every cold start and a day's work never reaches disk.
              - no `onGeolocationPermissionsShowPrompt`, so
                `navigator.geolocation` is denied with no prompt and no error.
              - no `onShowFileChooser`, so `<input type="file">` does nothing
                and the camera and photo library are simply unreachable.
              - no alert or confirm handling on either platform, so the app's
                two `window.confirm` calls always answer no.

            It also has no navigation interception at all — no
            `shouldOverrideUrlLoading`, no `decidePolicyFor` — which is why
            `onShouldStartLoadWithRequest` below could not be honoured under it.

            `react-native-webview` implements every one of those, requests the
            Android runtime permission itself, and sets `domStorageEnabled` at
            view creation. It is also the older, far more exercised path.

            What it costs: `@expo/dom-webview`'s `useExpoModulesBridge`, which
            lets DOM code call Expo native modules directly. Nothing here uses
            it, and its own docs say to leave it off for content that is not
            fully trusted.
          */
          useExpoDOMWebView: false,

          /*
            Stated rather than inherited. The whole app's persistence hangs on
            this one flag, and `react-native-webview` happens to default it on
            — which is exactly the sort of invisible dependency that produced
            the bug above. Say it, and a library changing its mind cannot sign
            every rep out.
          */
          domStorageEnabled: true,

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
            Location, which the webview will not ask for on its own. On Android
            this is what installs the permission prompt; without it
            `navigator.geolocation` is refused silently, the route cannot order
            itself from where the rep is standing, and a tapped house has no
            position to compare against — the app looks broken rather than
            unpermitted.

            iOS does not read this prop: WKWebView implements geolocation
            itself and gates it on the app's own authorisation, so what matters
            there is the `NSLocationWhenInUseUsageDescription` in app.json.
          */
          geolocationEnabled: true,

          /*
            Android routes a `target="_blank"` through
            `shouldOverrideUrlLoading` only when it is not asked to support
            multiple windows. Left at its default of `true`, the four external
            links in the app would do nothing at all on Android — including the
            directions handoff — and `onShouldStartLoadWithRequest` would never
            see them.
          */
          setSupportMultipleWindows: false,
          onShouldStartLoadWithRequest,

          /*
            Android's own zoom, which is on by default in this webview
            (`RNCWebViewManagerImpl` sets `builtInZoomControls = true`) and is a
            second way into the same bug `user-scalable=no` closes on iOS: the
            map's own pinch handler and the page's zoom both answer one gesture,
            and the page stays magnified after the rep navigates away.
          */
          setBuiltInZoomControls: false,

          /*
            Android's half of `scrollEnabled: false` above, which Android's
            webview does not implement. Without it the whole page stretches
            (Android 12+) when a rep drags past the end of a list, as if the
            app itself were a scrolling page — on iOS the page never moves.
          */
          overScrollMode: 'never',

          /*
            Android scales every page by the phone's font-size setting unless
            told otherwise, and Samsung phones ship above 100%. The app's
            layout is sized in fixed steps (16px fields, fixed rows), so a
            scaled page overflowed buttons and pushed rows off screen — while
            the same app on iOS, whose webview does not do this, was fine.
            100 makes Android draw it the way iOS does.
          */
          textZoom: 100,

          /*
            Expo's wrapper sets this to `__DEV__` and stops there, which leaves a
            preview build with no inspector and — since `RNCWebChromeClient`
            drops console output outside `DEBUG` as well — no way to report a
            blank page at all. Three Android preview builds were undiagnosable
            for exactly that reason. The wrapper spreads these props after its
            own, so this one wins. `lib/inspectable.ts` keeps it shut for
            production and for any channel it does not recognise.
          */
          webviewDebuggingEnabled: WEBVIEW_INSPECTABLE,

          mediaPlaybackRequiresUserAction: false,
          /*
            `react-native-webview` defaults this off, where Expo's webview
            defaults it on. Off forces every video fullscreen, which is not what
            a training clip inside a screen should do.
          */
          allowsInlineMediaPlayback: true,
          /*
            Note dictation now goes through the phone's recogniser (see
            `lib/dictation.ts`); this stays for anything else on the page that
            asks the webview for the microphone. The page is our own bundle,
            loaded from a file URL, so the webview grants that request itself
            and iOS shows its one system prompt for the microphone and for
            speech recognition — both described in app.json. Without the two
            Info.plist strings iOS refuses outright and the note said
            "Microphone access is blocked" with nothing anybody could allow.
          */
          mediaCapturePermissionGrantType: 'grant',
          style: styles.fill,
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
})
