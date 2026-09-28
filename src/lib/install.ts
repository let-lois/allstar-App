/**
 * Installing the app to the home screen.
 *
 * "Download the app" means this. There is no store listing: the PWA is the
 * app, and installed it opens full-screen, keeps its own storage quota, and
 * works with no signal from the icon on the home screen. The difference
 * between a rep who installed it and one who bookmarked it is the difference
 * between an app and a web page, and it is worth one screen of onboarding.
 *
 * Two platforms, two mechanics:
 *
 *   Chromium (Android, desktop) fires `beforeinstallprompt` once, early, and
 *   only for an origin it judges installable. The event has to be caught and
 *   kept, because calling `prompt()` is the only way to show the install
 *   sheet and it can only be called on that saved event, from a tap.
 *
 *   iOS Safari has no event and no prompt. The only route is the share sheet's
 *   "Add to Home Screen", and the only thing the app can do is tell people
 *   where it is. This was task #22 ("iOS-only Add to Home Screen hint"),
 *   parked for want of a place to put it; onboarding is the place.
 *
 * The listener is armed at module load — from main.tsx, before React renders —
 * because the event can fire before any component has mounted, and an event
 * nobody was listening for is an install prompt that never appears.
 */

import { isNativeShell } from './webview'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())

export function armInstallPrompt(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    notify()
  })
}

/** Running from the home screen already. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) && !/CriOS|FxiOS/i.test(navigator.userAgent)
}

/** Chromium has offered an install and the offer is still in hand. */
export const canPromptInstall = (): boolean => deferred !== null

/** Show the browser's install sheet. Only from a tap; resolves to the choice. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const ev = deferred
  if (!ev) return 'unavailable'
  deferred = null
  notify()
  try {
    await ev.prompt()
    const choice = await ev.userChoice
    return choice.outcome
  } catch {
    return 'dismissed'
  }
}

/** Re-render when the offer arrives or is used. */
export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export type InstallState = 'installed' | 'promptable' | 'ios' | 'manual'

export function installState(): InstallState {
  // The store app is installed by definition. Without this the shell — which
  // is neither `display-mode: standalone` nor `navigator.standalone` — told
  // iPhone users to add it to their home screen from Safari.
  if (isNativeShell() || isStandalone()) return 'installed'
  if (canPromptInstall()) return 'promptable'
  if (isIOS()) return 'ios'
  return 'manual'
}
