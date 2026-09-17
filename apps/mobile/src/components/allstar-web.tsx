'use dom'

/**
 * The whole All-Star web app, running inside the native app.
 *
 * The day-one milestone of the migration, and meant to be temporary. The
 * `'use dom'` directive tells Metro to bundle this file and everything it
 * imports as *web* code and hand it to a webview, so the app a rep uses today
 * runs on a phone before a single screen has been rewritten — and each screen
 * can then be replaced with a native one without a flag day. See
 * docs/MIGRATION_PROGRESS.md for the order.
 *
 * It is not free: a DOM component carries a web runtime, and JavaScript parsed
 * from source starts slower than Hermes bytecode. Today, the map and the leads
 * list are the screens that will feel it first, which is why they are the
 * first marked nativize-now.
 *
 * This file is the web app's `src/main.tsx` with the differences a webview
 * forces, each one commented below rather than left to be rediscovered.
 */

import { MemoryRouter } from 'react-router-dom'

import { App } from '@web/App'
import { apply, readChoice } from '@web/lib/theme'
import { API_URL } from '@web/lib/http'
import '@web/index.css'
import type { ApiRequest, ApiResponse } from '@/lib/api-bridge'

/*
  Safe-area insets, which the wrapper HTML does not ask for.

  Expo builds the page around a DOM component itself, and its viewport tag is
  `width=device-width, initial-scale=1, user-scalable=no` — no
  `viewport-fit=cover`. Without that keyword every `env(safe-area-inset-*)`
  resolves to 0, so the app's `--safe-top` and `--dock-space` collapse: content
  runs under the notch and the bottom dock sits beneath the home indicator.
  The app's own index.html carries the keyword with the comment "so the map can
  run under the notch/home indicator", which is exactly the screen where its
  absence showed first.

  Rewritten rather than appended: a second viewport tag is ignored, and WKWebView
  applies a change to the existing one immediately.
*/
function widenViewport() {
  const tag = document.querySelector('meta[name="viewport"]')
  const content =
    'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=5'
  if (tag) tag.setAttribute('content', content)
  else {
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = content
    document.head.appendChild(meta)
  }
}

/*
  API calls, routed through the native side.

  The webview is loaded with `loadFileURL`, so its origin is `file://` and every
  cross-origin `fetch` it makes carries `Origin: null`. The Worker echoes CORS
  headers only for an origin in its `ALLOWED_ORIGINS` list; `null` is not one,
  so it answers with no CORS headers at all, the browser discards the response,
  and the app reports a network problem. The symptom is "signing in does not
  work even with the right password", and the Worker's own comment predicts it:
  "turns 'nobody can sign in' into a one-line fix in wrangler tail".

  The alternative was to add `null` to the server's allowlist. That is a
  production configuration change to let every sandboxed page in the world talk
  to the API, to fix a client that should not have needed it — so the request
  goes over the bridge instead, where React Native's `fetch` is not a browser
  and CORS does not apply. No server change, and nothing else about `http.ts`
  has to know.

  Only requests to the API are diverted. Map tiles, the Google Maps script and
  anything else keep the webview's own `fetch`, because they are either not
  CORS-restricted or not ours to reroute.
*/
let installed = false
function routeApiThroughNative(send: (req: ApiRequest) => Promise<ApiResponse>) {
  if (installed) return
  installed = true
  const browserFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!API_URL || !url.startsWith(API_URL)) return browserFetch(input as RequestInfo, init)

    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (value, key) => {
        headers[key] = value
      },
    )

    const body = init?.body
    if (body != null && typeof body !== 'string') {
      /*
        Nothing sends one today — every request body in `http.ts` is a JSON
        string — but failing loudly beats a request that silently loses its
        body and returns a confusing 400 from the server.
      */
      throw new TypeError(
        `The native API bridge can only carry a string body; got ${body.constructor.name}. ` +
          'Base64 it on both sides, as the response path does.',
      )
    }

    const res = await send({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body: body ?? undefined,
    })

    const payload = res.isBase64
      ? Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0))
      : res.body
    return new Response(payload as BodyInit, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}

/*
  The theme, before React renders anything — the same reason the web entry does
  it. A webview starts with no `data-theme` at all, so without this the app
  paints dark and then flips when the More screen mounts the toggle.
*/
apply(readChoice())

export default function AllStarWeb({
  apiFetch,
}: {
  apiFetch: (req: ApiRequest) => Promise<ApiResponse>
  dom?: import('expo/dom').DOMProps
}) {
  /*
    Both run in the component body rather than an effect. React renders a parent
    before its children, so this happens before any screen mounts and before
    anything can issue a request — an effect would run after, and the first
    fetch of the session would go out through the browser and fail.
  */
  widenViewport()
  routeApiThroughNative(apiFetch)

  return (
    <MemoryRouter>
      <App />
    </MemoryRouter>
  )
}
