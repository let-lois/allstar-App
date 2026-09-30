import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { IconBack } from './icons'
import { HelpButton } from './HelpButton'

interface Props {
  title: string
  subtitle?: string
  back?: boolean | string
  right?: ReactNode
  /** Sits directly under the title — filter chips, segmented controls. */
  below?: ReactNode
  /**
   * Replaces the visible title block — a profile photo and who is signed in.
   *
   * The `title` is still required and still rendered, for screen readers only.
   * A page needs a heading whether or not it is drawn: swapping the visible h1
   * for a person's name would make "Platform" disappear from the document
   * outline, and the outline is how somebody navigating by heading finds out
   * what screen they are on.
   */
  identity?: ReactNode
  /**
   * The Help question mark at the far right. On by default, so every screen
   * with a header has it in the same place; off only where the screen already
   * leads somewhere Help could not be reached from safely (a flow that must
   * not be left halfway).
   */
  help?: boolean
}

/**
 * Compact header. Deliberately thin: on a 667pt phone every point spent on
 * chrome is a point not spent on the next property.
 *
 * Note what is *not* here — no primary action in the top-right. Anything the
 * rep actually does lives at the bottom of the screen, in thumb range.
 */
export function TopBar({ title, subtitle, back, right, below, identity, help = true }: Props) {
  const nav = useNavigate()
  /*
    Two sizes of title, decided by where the screen sits.

    A root screen — Today, Leads, Lists, More — is a place the rep arrives at
    from the dock, and its name is the largest thing on it: 28px, the way a
    native app announces a tab. A screen with a Back control is somewhere they
    went, and its title is a label beside the arrow at 17px, so the content it
    describes keeps the room. One component, one rule, so no screen sizes its
    own heading. Identity headers (the console's company lockup) keep their
    own layout.
  */
  const large = !back && !identity
  return (
    <header className="topbar-lit pad-top z-20 shrink-0" data-title-size={large ? 'large' : 'compact'}>
      <div className={`flex items-center gap-1 px-2 ${large ? 'min-h-[68px]' : 'min-h-[54px]'}`}>
        {back && (
          <button
            onClick={() => (typeof back === 'string' ? nav(back) : nav(-1))}
            aria-label="Back"
            className="focusable grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink active:bg-surface-field"
          >
            <IconBack />
          </button>
        )}
        <div className={`min-w-0 flex-1 ${back ? 'pl-0.5' : large ? 'py-3 pl-3' : 'pl-3'}`}>
          {identity ? (
            <>
              <h1 className="sr-only">{title}</h1>
              {identity}
            </>
          ) : (
            <>
              {/* -0.01em: at 17px semibold the default tracking reads loose against
                  the tighter display sizes used for numbers on the same screens. */}
              <h1
                className={
                  large
                    ? 'truncate text-[28px] font-semibold leading-none tracking-[-0.02em]'
                    : 'truncate text-[17px] font-semibold leading-tight tracking-[-0.01em]'
                }
              >
                {title}
              </h1>
              {subtitle && (
                <p className={`truncate leading-tight text-ink-mute ${large ? 'mt-1 text-[13.5px]' : 'text-[12.5px]'}`}>
                  {subtitle}
                </p>
              )}
            </>
          )}
        </div>
        {(right || help) && (
          <div className="flex shrink-0 items-center gap-1 pr-2">
            {right}
            {help && <HelpButton />}
          </div>
        )}
      </div>
      {below && <div className="px-4 pb-2.5">{below}</div>}
    </header>
  )
}
