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

import { useDOMImperativeHandle, type DOMImperativeFactory } from 'expo/dom'
import { useEffect, useRef, type Ref } from 'react'
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from 'react-router-dom'

import { App } from '@web/App'
import { apply, readChoice } from '@web/lib/theme'
import { API_URL } from '@web/lib/http'
import '@web/index.css'
import { installApiProxy, type ApiRequest, type ApiResponse } from '@/lib/api-bridge'
import type { ShellBridge } from '@web/lib/external'

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

  3. And one difference from the web app on purpose: **page zoom is off here.**

     The web app's own index.html allows it (`maximum-scale=5`), which is right
     for a website — pinch-zoom is an accessibility affordance and a browser
     always gives you a way back out of it.

     Inside the shell it is a bug, reported from a phone. `FieldMap` implements
     its own pinch-to-zoom, so on the map screen one gesture drives two things:
     the map zooms *and* the page zooms. The page zoom then persists across
     navigation — a rep pinched the map, went to Overview, and found the whole
     app magnified with no URL bar, no reload and no way to undo it. And a
     magnified page is why the Add-lead form needed scrolling for every field.

     `user-scalable=no` rather than `maximum-scale=1`, because iOS honours the
     former in a WKWebView and treats the latter as advisory. Text size is not
     lost: the app's fields are already 16px so iOS never zooms to a focused
     input, and OS-level text sizing still applies.
*/
function ownTheScreen() {
  const content =
    'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no'
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

export interface AllStarWebRef extends DOMImperativeFactory {
  /** Go back one screen inside the web app. See `BackBridge`. */
  goBack: () => void
}

/**
 * Android's back button, which the web app cannot see.
 *
 * The app runs under `MemoryRouter`, so its history is its own — it never
 * touches `window.history`, and the native side has a single Expo Router
 * route. So a back press had nothing to go back to and **exited the app**: a
 * rep three screens into a lead form reached for back and lost what they were
 * typing.
 *
 * Two things have to cross the bridge for this to work, in opposite
 * directions. Whether going back is even possible is a fact only the web side
 * knows, and it travels up as a native action. The instruction to do it comes
 * down as an imperative handle, which is the documented way for native code to
 * call into a DOM component.
 *
 * Depth is counted rather than read, because React Router does not expose its
 * memory history's index. `useNavigationType` says how the *last* navigation
 * happened, so the arithmetic is: a push is one deeper, a pop is one shallower,
 * and a replace changes nothing. Counting rather than tracking keys is
 * deliberate — a pop returns to an entry's original key, so a key-based scheme
 * mistakes a revisit for a new screen.
 *
 * There is no `StrictMode` in this tree (the shell renders the router directly
 * rather than going through the web app's `main.tsx`), so the effect is not
 * double-invoked and the count does not drift.
 */
function BackBridge({
  onCanGoBack,
  register,
}: {
  onCanGoBack?: (canGoBack: boolean) => Promise<void>
  register: (goBack: () => void) => void
}) {
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const location = useLocation()
  const depth = useRef(0)

  register(() => {
    if (depth.current > 0) navigate(-1)
  })

  useEffect(() => {
    if (navigationType === 'PUSH') depth.current += 1
    else if (navigationType === 'POP') depth.current = Math.max(0, depth.current - 1)
    void onCanGoBack?.(depth.current > 0)
    // `location` rather than `location.key`: the object identity changes once
    // per navigation, which is exactly how often this should run.
  }, [location, navigationType, onCanGoBack])

  return null
}

export default function AllStarWeb({
  apiFetch,
  openExternal,
  onCanGoBack,
  ref,
}: {
  apiFetch: (req: ApiRequest) => Promise<ApiResponse>
  /** Native action: open a tel:, sms: or mailto: link, and say whether it did. See `web/lib/external.ts`. */
  openExternal?: (url: string) => Promise<{ ok: boolean }>
  /** Native action: told whenever going back becomes possible or impossible. */
  onCanGoBack?: (canGoBack: boolean) => Promise<void>
  ref?: Ref<AllStarWebRef>
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
  // Call, Text and Email go through this rather than navigating the webview.
  if (openExternal) {
    const w = window as Window & { __allstarShell?: ShellBridge }
    w.__allstarShell = { ...w.__allstarShell, openExternal }
  }

  /*
    The handle is published from here because `useDOMImperativeHandle` has to
    run in the component the native side holds a ref to — but `useNavigate`
    only works inside the router. So `BackBridge` fills this in from in there
    and the handle reads through it. A box, not a callback, so publishing it
    does not re-render anything.
  */
  const goBack = useRef<(() => void) | null>(null)
  useDOMImperativeHandle<AllStarWebRef>(
    // `null` is a valid ref and the hook's parameter is not optional, so an
    // absent one is spelled out rather than passed through as `undefined`.
    ref ?? null,
    (): AllStarWebRef => ({
      goBack: () => {
        goBack.current?.()
      },
    }),
    [],
  )

  return (
    <MemoryRouter>
      <BackBridge
        onCanGoBack={onCanGoBack}
        register={(fn) => {
          goBack.current = fn
        }}
      />
      <App />
    </MemoryRouter>
  )
}

/*
  No named export here, deliberately, and Metro will not let there be one: a
  module with `use dom` "only support[s] a single default export", because the
  directive replaces the module with a proxy reference. So `verify-shell.mjs`
  cannot import `BackBridge` to test it and drives it through the real bridge
  channels instead — the `onCanGoBack` action and the `_domRefProxy` handle,
  which is the more faithful test anyway.

  `AllStarWebRef` above is an `interface`, erased before the check sees it.
*/
