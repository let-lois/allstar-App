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
import { installApiProxy, type ApiRequest, type ApiResponse } from '@/lib/api-bridge'

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
  API calls go over the native bridge — see `src/lib/api-bridge.ts` for why
  (the webview's origin is `file://`, so the Worker refuses its CORS).
  Installed rather than implemented here so it can be tested without a phone.
*/

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
  installApiProxy(apiFetch, API_URL)

  return (
    <MemoryRouter>
      <App />
    </MemoryRouter>
  )
}
