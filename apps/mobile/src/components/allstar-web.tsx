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
  The page box, which Expo's wrapper HTML leaves half-specified.

  Expo builds the page around a DOM component itself, and two things it does
  are wrong for an app that expects to own the whole screen:

  1. Its viewport tag is `width=device-width, initial-scale=1,
     user-scalable=no` — **no `viewport-fit=cover`**. Without that keyword
     every `env(safe-area-inset-*)` resolves to 0, so the app's `--safe-top`
     and `--dock-space` collapse: content runs under the notch and the bottom
     dock sits beneath the home indicator. The app's own index.html carries the
     keyword with the comment "so the map can run under the notch/home
     indicator", which is the screen where its absence showed first.

  2. Its style block sets `-webkit-overflow-scrolling` on `html, body` and
     `display: flex; flex: 1` on `#root`, but no height and no margin reset.
     The app's own CSS does set `html, body, #root { height: 100% }`, so that
     part is covered — but a stray body margin and a `flex` root that the app
     does not expect are not, and a 100%-height chain inside a flex parent with
     no explicit basis is exactly how a full-screen map ends up the wrong size.

  Both are corrected here rather than worked around per screen. The viewport
  tag is rewritten in place because a second one is ignored, and WKWebView
  applies a change to the existing tag immediately.
*/
function ownTheScreen() {
  const content =
    'width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=5'
  const tag = document.querySelector('meta[name="viewport"]')
  if (tag) tag.setAttribute('content', content)
  else {
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = content
    document.head.appendChild(meta)
  }

  /*
    Appended last so it wins over Expo's own `#expo-dom-component-style`
    without editing it. Deliberately only the box: every colour, size and
    spacing decision stays in the app's index.css, which is the single source
    for them.

    Guarded by its own id, which is what the id was for and was not doing. This
    runs in the component body rather than an effect (see below, and it has to),
    and the DOM root re-renders whenever the native side emits props — so it
    appended another identical stylesheet every time. The viewport rewrite above
    needs no guard: setting an attribute to the value it already has is free.
  */
  if (document.getElementById('allstar-shell-box')) return
  const style = document.createElement('style')
  style.id = 'allstar-shell-box'
  style.textContent = `
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    /* The app's own shell scrolls its regions; the page itself must not. */
    #root { display: block; flex: none; height: 100%; width: 100%; }
  `
  document.head.appendChild(style)
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
  ownTheScreen()
  installApiProxy(apiFetch, API_URL)

  return (
    <MemoryRouter>
      <App />
    </MemoryRouter>
  )
}
