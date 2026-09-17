import { useState } from 'react'
import { Button } from '../components/ui/Button'
import { IconCheck, IconDoor, IconLeads, IconMap, IconTrophy } from '../components/nav/icons'
import { WALKTHROUGH, type WalkthroughIcon } from '../data/walkthrough'
import type { StepProps } from './steps'

/**
 * Step 3 — learn the basics: five cards, one at a time.
 *
 * Deliberately not the tour. The tour walks the live interface across five
 * screens and takes minutes; this is the sixty-second version, and it is
 * offered *before* the person has any data to spotlight. The tour is one tap
 * away from the last screen, and from More, for whoever wants the long form.
 */

const ICONS: Record<WalkthroughIcon, () => React.JSX.Element> = {
  map: IconMap,
  door: IconDoor,
  check: IconCheck,
  leads: IconLeads,
  trophy: IconTrophy,
}

export function WalkthroughStep({ busy, error, post }: StepProps) {
  const [index, setIndex] = useState(0)
  const card = WALKTHROUGH[index]!
  const last = index === WALKTHROUGH.length - 1
  const Icon = ICONS[card.icon]

  return (
    <div className="anim-rise">
      <div
        className="card mt-2 flex min-h-[320px] flex-col items-center justify-center px-6 py-10 text-center"
        data-testid="walkthrough-card"
        data-index={index}
        data-key={card.key}
      >
        {/*
          One large icon from the set, in the accent. Not an illustration: the
          brief asked for clean and professional, and the icons already carry
          the app's shapes — this is the same map the rep will see on the next
          screen, not a picture of a map.
        */}
        <span className="grid h-20 w-20 place-items-center rounded-full bg-surface-tint text-accent [&>svg]:h-10 [&>svg]:w-10" aria-hidden>
          <Icon />
        </span>
        <h2 className="mt-6 text-[23px] font-semibold leading-tight tracking-[-0.01em]">{card.title}</h2>
        <p className="mt-3 max-w-[30ch] text-[15.5px] leading-relaxed text-ink-mute">{card.body}</p>
      </div>

      {/* Dots: where you are in five. Buttons, so a thumb can jump. */}
      <div className="mt-5 flex items-center justify-center gap-2" role="tablist" aria-label="Walkthrough progress">
        {WALKTHROUGH.map((c, i) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={`${i + 1} of ${WALKTHROUGH.length}: ${c.title}`}
            onClick={() => setIndex(i)}
            className="focusable grid h-11 w-8 place-items-center"
          >
            <span className={`block h-2 rounded-full transition-all ${i === index ? 'w-6 bg-brand-500' : 'w-2 bg-line'}`} />
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-3">
        <Button
          variant="secondary"
          size="lg"
          className="flex-1"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          Back
        </Button>
        {last ? (
          <Button size="lg" className="flex-[2]" disabled={busy} onClick={() => void post('walkthrough')} data-testid="walkthrough-done">
            {busy ? 'Saving…' : 'Continue'}
          </Button>
        ) : (
          <Button size="lg" className="flex-[2]" onClick={() => setIndex((i) => i + 1)} data-testid="walkthrough-next">
            Next
          </Button>
        )}
      </div>
    </div>
  )
}
