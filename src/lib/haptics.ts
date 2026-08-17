/**
 * Confirmation you can feel through a glove, without looking at the screen.
 * Used only for state changes the rep needs to trust (outcome recorded, visit
 * completed) — never for navigation.
 */
type Pattern = 'tap' | 'confirm' | 'warn'

const patterns: Record<Pattern, number | number[]> = {
  tap: 10,
  confirm: [12, 40, 18],
  warn: [30, 60, 30],
}

export function haptic(kind: Pattern = 'tap') {
  try {
    navigator.vibrate?.(patterns[kind])
  } catch {
    /* unsupported — silent */
  }
}
