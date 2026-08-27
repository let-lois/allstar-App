/**
 * Light or dark, and who decides.
 *
 * Three settings, not two. `system` follows the phone, which is what most people
 * want most of the time; `light` and `dark` are a deliberate override, which is
 * what a rep wants when the operating system's idea of the time of day has
 * nothing to do with the sun on their screen. A two-way toggle cannot express
 * "follow the phone" once it has been touched, and that is the state people
 * actually want back.
 *
 * The applied value lives on `<html data-theme>`; the *preference* lives in
 * localStorage. They are different things — `system` is a preference and never
 * an applied value — and conflating them is what makes a toggle stop tracking
 * the phone after the first tap.
 */

export type ThemeChoice = 'system' | 'light' | 'dark'
export type ThemeApplied = 'light' | 'dark'

/**
 * localStorage, deliberately, when the rest of the app's state is in IndexedDB.
 *
 * The theme has to be readable *synchronously, before first paint*, by the
 * snippet in `index.html` — IndexedDB is async and would guarantee a flash of
 * the wrong theme on every cold start. It is also the one piece of state that
 * should survive a sign-out, since it belongs to the phone rather than the
 * account.
 */
export const THEME_KEY = 'allstar.theme'

export function readChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
  } catch {
    // Private mode, or storage disabled. Following the phone is the right
    // fallback, and it is also what the pre-paint snippet will have applied.
    return 'system'
  }
}

/** What the phone is asking for right now. */
export function systemTheme(): ThemeApplied {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function resolve(choice: ThemeChoice): ThemeApplied {
  return choice === 'system' ? systemTheme() : choice
}

/**
 * Put it on the document, and tell the browser chrome about it.
 *
 * `theme-color` is the strip behind the status bar and the pull-to-refresh
 * area. Left pinned to the dark ground it is the one part of a light theme that
 * stays black, and it looks like a rendering bug rather than a setting.
 */
export function apply(choice: ThemeChoice): ThemeApplied {
  const applied = resolve(choice)
  const root = document.documentElement
  root.dataset.theme = applied
  const ground = getComputedStyle(root).getPropertyValue('--surface-sunk').trim()
  if (ground) {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', `rgb(${ground.replace(/\s+/g, ' ')})`)
  }
  return applied
}

export function saveChoice(choice: ThemeChoice): ThemeApplied {
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {
    // Not fatal: the theme still applies for this session, it just will not
    // survive a reload. Refusing to switch because we cannot remember it would
    // be the worse trade.
  }
  return apply(choice)
}

/**
 * Follow the phone while the preference is `system`.
 *
 * Without this the app only tracks the OS at boot, so a phone that flips to
 * dark at sunset leaves the app light until it is next launched — on the
 * setting whose whole promise is that it follows along.
 */
export function watchSystem(onChange: (applied: ThemeApplied) => void): () => void {
  let mq: MediaQueryList
  try {
    mq = window.matchMedia('(prefers-color-scheme: light)')
  } catch {
    return () => {}
  }
  const handler = () => {
    if (readChoice() === 'system') onChange(apply('system'))
  }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
