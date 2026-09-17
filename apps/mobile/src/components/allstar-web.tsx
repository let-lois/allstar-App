'use dom'

/**
 * The whole All-Star web app, running inside the native app.
 *
 * This is the day-one milestone of the migration, and it is meant to be
 * temporary. The `'use dom'` directive tells Metro to bundle this file and
 * everything it imports as *web* code and hand it to a webview, so the app a
 * rep uses today runs on a phone from the App Store before a single screen has
 * been rewritten — and each screen can then be replaced with a native one
 * without a flag day. See docs/MIGRATION_PROGRESS.md for the order.
 *
 * It is not free: a DOM component carries a web runtime, and JavaScript parsed
 * from source starts slower than Hermes bytecode. Today, the map and the leads
 * list are the screens that will feel it first, which is why they are the first
 * three marked nativize-now.
 *
 * This file is the web app's `src/main.tsx` with three deliberate differences:
 *
 * 1. **MemoryRouter, not BrowserRouter.** There is no address bar in a webview
 *    and no server to ask for a path, so history lives in memory. A
 *    BrowserRouter here navigates to a URL the bundle cannot serve.
 * 2. **No service worker.** It exists to cache the app shell for an offline
 *    cold start on the web. The native bundle is already on the device, so it
 *    would cache a copy of something that cannot be missing.
 * 3. **No install prompt.** `armInstallPrompt()` catches the browser's
 *    "add to home screen" offer. Inside an app that came from the App Store
 *    there is nothing to install.
 *
 * Everything else — IndexedDB, the sync queue, the theme, every screen — is
 * the web app unmodified. The offline-first storage genuinely works, because a
 * webview has a real IndexedDB.
 */

import { MemoryRouter } from 'react-router-dom'

import { App } from '@web/App'
import { apply, readChoice } from '@web/lib/theme'
import '@web/index.css'

/*
  The theme, before React renders anything — the same reason the web entry does
  it, minus the stale-service-worker story that motivated it there. A webview
  starts with no `data-theme` at all, so without this the app paints dark and
  then flips when the More screen mounts the toggle.
*/
apply(readChoice())

export default function AllStarWeb(_: { dom?: import('expo/dom').DOMProps }) {
  return (
    <MemoryRouter>
      <App />
    </MemoryRouter>
  )
}
