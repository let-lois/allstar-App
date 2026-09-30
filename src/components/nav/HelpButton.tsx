import { IconHelp } from './icons'
import { HELP_URL } from '../../lib/help'

/**
 * The question mark in the corner of every main screen: All Star Help.
 *
 * A plain link rather than a button, because it goes somewhere: the phone
 * shell hands an https link to the in-app browser, a desktop browser opens a
 * tab. 44 by 44 like every other control in the header, and quiet — it is
 * there for the moment somebody is stuck, not competing with the screen.
 *
 * `floating` is the map's version: the same mark on a round plate, for a
 * screen with no header to sit in.
 *
 * A tap on it is its own and nothing else's: it never reaches the map under
 * it (no pin, no selection, no drawing point), nor a row or card it sits in.
 * Only propagation is stopped — the link still opens.
 */
const own = (e: { stopPropagation: () => void }) => e.stopPropagation()
export function HelpButton({ floating = false }: { floating?: boolean }) {
  return (
    <a
      href={HELP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Help"
      title="Help"
      data-testid="help-button"
      onClick={own}
      onPointerDown={own}
      onMouseDown={own}
      onTouchStart={own}
      className={
        floating
          ? 'icon-sm press focusable metal metal-map grid min-h-[44px] w-11 shrink-0 place-items-center rounded-pill text-ink-soft'
          : 'focusable grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-soft active:bg-surface-field'
      }
    >
      <IconHelp />
    </a>
  )
}
