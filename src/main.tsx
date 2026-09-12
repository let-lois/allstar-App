import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import './index.css'
import { apply, readChoice } from './lib/theme'
import { armInstallPrompt } from './lib/install'

/**
 * Apply the theme before React renders anything.
 *
 * The pre-paint snippet in `index.html` normally does this, and this looks like
 * belt and braces until the snippet is not there — which happens for real. The
 * service worker caches the app shell, so a phone still holding a shell from
 * before the themes shipped boots with no `data-theme` at all. CSS then falls
 * back to the dark `:root`, the app looks dark, and it stays dark right up until
 * the More screen mounts the toggle, which applies the *actual* preference and
 * flips the whole app mid-session.
 *
 * That was reported as "I am on dark mode and clicking More switches me to
 * light", and it is exactly what it looks like: the first component that reads
 * the preference was the one that also applied it.
 *
 * Applying here makes the stored preference authoritative from the first frame
 * on every screen, so a stale shell costs a flash rather than a wrong theme.
 */
apply(readChoice())

// Catch the browser's install offer before any screen exists to ask for it.
// It fires once, early, and an offer nobody was listening for is gone.
armInstallPrompt()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// App-shell caching so a cold start with no signal still boots. Registered after
// load so it never competes with first paint on a slow connection.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell unavailable — the IndexedDB cache still works */
    })
  })
}
