import type { OutcomeCode } from '../../types'
import { useOutcomes } from '../../lib/useSettings'
import { haptic } from '../../lib/haptics'

/*
 * Outcome tile tones.
 *
 * Every pair is measured, not chosen by eye, because this control is tapped
 * forty to eighty times a day in direct sunlight. Three of the previous selected
 * fills put white text below 4.5:1 — teal-600 at 3.74, amber-600 at 3.19,
 * sky-600 at 4.10 — so the selected state, the one that has to be unmistakable,
 * was the least legible thing on the screen. These fills are taken bright enough
 * that a near-black label clears AA on all eight — 6.7:1 at the tightest.
 *
 * The selected label is `text-surface-sunk`, the ground colour, not `text-ink`.
 * Ink is near-white now; the eight fills are saturated and bright; white on any
 * of them is unreadable. This is the same inversion `.metal-brand` makes and for
 * the same reason: a bright face takes a dark label whatever the theme is.
 *
 * The hues stay distinct rather than collapsing into the brand orange: a rep
 * learns these eight tiles by position and colour, and the accent is not a
 * meaning.
 */
const TONE_BG: Record<string, string> = {
  noanswer: 'bg-surface-field text-ink-soft border-line',
  interested: 'bg-[#10302E] text-[#5FD3C4] border-[#5FD3C4]/25',
  followup: 'bg-warn-bg text-warn border-warn/25',
  appointment: 'bg-[#241C3E] text-[#C0A6FA] border-[#C0A6FA]/25',
  quote: 'bg-[#16283F] text-[#7DC0F5] border-[#7DC0F5]/25',
  notinterested: 'bg-surface-field text-ink-soft border-line',
  sold: 'bg-good-bg text-good border-good/25',
  dnc: 'bg-bad-bg text-bad border-bad/25',
}

const TONE_ON: Record<string, string> = {
  noanswer: 'bg-[#94A3B8] text-surface-sunk border-[#94A3B8]',
  interested: 'bg-[#2DD4BF] text-surface-sunk border-[#2DD4BF]',
  followup: 'bg-warn text-surface-sunk border-warn',
  appointment: 'bg-[#A78BFA] text-surface-sunk border-[#A78BFA]',
  quote: 'bg-[#38A8F0] text-surface-sunk border-[#38A8F0]',
  notinterested: 'bg-ink-mute text-surface-sunk border-ink-mute',
  sold: 'bg-good text-surface-sunk border-good',
  dnc: 'bg-bad text-surface-sunk border-bad',
}

/**
 * Outcome selector.
 *
 * This is the single most-tapped control in the product — forty to eighty times
 * a day, outdoors, one-handed, often without looking directly at the screen. So:
 *
 *  - "No answer" spans the full width and comes first; it's ~2/3 of all knocks
 *    and deserves to be the target you can hit blind.
 *  - Everything else is a 2-up grid of 80px tiles, well past the 48px minimum.
 *  - Color *and* glyph *and* text carry the meaning — color alone fails in
 *    direct sunlight and for colorblind reps.
 */
export function OutcomeGrid({
  value,
  onChange,
}: {
  value?: OutcomeCode
  onChange: (code: OutcomeCode) => void
}) {
  const [primary, ...rest] = useOutcomes()

  const tile = (code: OutcomeCode, tone: string, glyph: string, label: string, full = false) => {
    const on = value === code
    return (
      <button
        key={code}
        onClick={() => {
          haptic('confirm')
          onChange(code)
        }}
        aria-pressed={on}
        className={[
          'press focusable flex items-center justify-center gap-2.5 rounded-card border-2 font-bold',
          'transition-shadow',
          full ? 'min-h-[76px] w-full text-[19px]' : 'min-h-[84px] text-[15px] flex-col gap-1.5',
          on ? `${TONE_ON[tone]} shadow-raise` : TONE_BG[tone],
        ].join(' ')}
      >
        <span className={full ? 'text-xl' : 'text-2xl'} aria-hidden>
          {glyph}
        </span>
        <span className="text-center leading-tight">{label}</span>
      </button>
    )
  }

  return (
    <div className="space-y-2.5">
      {tile(primary.code, primary.tone, primary.glyph, primary.label, true)}
      <div className="grid grid-cols-2 gap-2.5">
        {rest.map((o) => tile(o.code, o.tone, o.glyph, o.label))}
      </div>
    </div>
  )
}
