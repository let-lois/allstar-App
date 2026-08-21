import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { IconBack } from './icons'

interface Props {
  title: string
  subtitle?: string
  back?: boolean | string
  right?: ReactNode
  /** Sits directly under the title — filter chips, segmented controls. */
  below?: ReactNode
}

/**
 * Compact header. Deliberately thin: on a 667pt phone every point spent on
 * chrome is a point not spent on the next property.
 *
 * Note what is *not* here — no primary action in the top-right. Anything the
 * rep actually does lives at the bottom of the screen, in thumb range.
 */
export function TopBar({ title, subtitle, back, right, below }: Props) {
  const nav = useNavigate()
  return (
    <header className="pad-top z-20 shrink-0 border-b border-line bg-surface/95 backdrop-blur">
      <div className="flex min-h-[54px] items-center gap-1 px-2">
        {back && (
          <button
            onClick={() => (typeof back === 'string' ? nav(back) : nav(-1))}
            aria-label="Back"
            className="focusable grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink active:bg-surface-field"
          >
            <IconBack />
          </button>
        )}
        <div className={`min-w-0 flex-1 ${back ? 'pl-0.5' : 'pl-3'}`}>
          {/* -0.01em: at 17px semibold the default tracking reads loose against
              the tighter display sizes used for numbers on the same screens. */}
          <h1 className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em]">
            {title}
          </h1>
          {subtitle && (
            <p className="truncate text-[12.5px] leading-tight text-ink-mute">{subtitle}</p>
          )}
        </div>
        {right && <div className="flex shrink-0 items-center gap-1 pr-2">{right}</div>}
      </div>
      {below && <div className="px-4 pb-2.5">{below}</div>}
    </header>
  )
}
