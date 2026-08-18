import type { OutcomeCode } from '../../types'
import { useOutcomes } from '../../lib/useSettings'
import { haptic } from '../../lib/haptics'

const TONE_BG: Record<string, string> = {
  noanswer: 'bg-slate-100 text-slate-700 border-slate-200',
  interested: 'bg-teal-50 text-teal-800 border-teal-200',
  followup: 'bg-amber-50 text-amber-800 border-amber-200',
  appointment: 'bg-violet-50 text-violet-800 border-violet-200',
  quote: 'bg-sky-50 text-sky-800 border-sky-200',
  notinterested: 'bg-slate-50 text-slate-600 border-slate-200',
  sold: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  dnc: 'bg-red-50 text-red-800 border-red-200',
}

const TONE_ON: Record<string, string> = {
  noanswer: 'bg-slate-600 text-white border-slate-600',
  interested: 'bg-teal-600 text-white border-teal-600',
  followup: 'bg-amber-600 text-white border-amber-600',
  appointment: 'bg-violet-600 text-white border-violet-600',
  quote: 'bg-sky-600 text-white border-sky-600',
  notinterested: 'bg-slate-500 text-white border-slate-500',
  sold: 'bg-emerald-600 text-white border-emerald-600',
  dnc: 'bg-red-600 text-white border-red-600',
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
          'press focusable flex items-center justify-center gap-2.5 rounded-2xl border-2 font-bold',
          full ? 'min-h-[72px] w-full text-lg' : 'min-h-[80px] text-[15px] flex-col gap-1.5',
          on ? TONE_ON[tone] : TONE_BG[tone],
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
