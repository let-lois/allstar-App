/**
 * When the shell checks for an over-the-air update, and when it applies one.
 *
 * expo-updates on its own downloads a new update in the background at launch
 * and applies it on the *next* cold start. Reopening the app from the app
 * switcher is not a cold start, so two phones on the same build could sit on
 * different updates for days — one reopened twice since the publish, one not —
 * and the latest UI only appeared after force-quitting, sometimes twice.
 *
 * So the shell asks too, at the two moments a person has just arrived:
 *
 *   launch        the app has only just opened; nothing is typed yet, so a
 *                 downloaded update is applied at once.
 *   foreground    back from the background. Applied only after a real absence
 *                 (AWAY_MS): a glance at a text message mid-note must not
 *                 reload the screen under the rep's thumb. A shorter absence
 *                 still downloads it, and the next launch or return applies it.
 *
 * Everything the app records is in IndexedDB before the screen confirms it, so
 * a reload loses no saved work — only whatever is half-typed, which is why the
 * foreground case waits.
 */

/** How long the app must have been away before a return applies an update. */
export const AWAY_MS = 5 * 60 * 1000

export type OtaMoment = { kind: 'launch' } | { kind: 'foreground'; awayMs: number }

/** Whether to check for an update at this moment at all. */
export function shouldCheck(enabled: boolean, dev: boolean, moment: OtaMoment): boolean {
  if (!enabled || dev) return false
  // A return after a moment away is still worth a check — the download is
  // cheap and the next real return can then apply it without waiting.
  return moment.kind === 'launch' || moment.awayMs >= 30_000
}

/** Whether a freshly downloaded update should be applied now (a reload). */
export function shouldApply(moment: OtaMoment): boolean {
  return moment.kind === 'launch' || moment.awayMs >= AWAY_MS
}
