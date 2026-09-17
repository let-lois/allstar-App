import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { IconCheck } from '../components/nav/icons'
import { installState, onInstallChange } from '../lib/install'
import type { ChecklistItemDTO } from '../lib/http'
import type { OnboardingStep } from '../types'
import type { StepProps } from './steps'

/**
 * Step 5 — ready to sell.
 *
 * Every line here is the server's, derived from the row — never a tick the
 * screen decided to draw. The one exception is "installed to home screen",
 * which is a fact about *this phone* the server cannot know, read live from
 * the browser and marked as such.
 *
 * Required lines block Complete; recommended ones do not and say so. A line
 * that is not done offers the way to fix it — back to the profile for a name
 * or a photo, back to the badge for a confirmation — rather than a red mark
 * with no door.
 */

const FIX: Partial<Record<ChecklistItemDTO['key'], OnboardingStep>> = {
  profile_complete: 'profile',
  photo_added: 'profile',
  badge_created: 'badge',
  badge_confirmed: 'badge',
  walkthrough_completed: 'walkthrough',
}

export function ChecklistStep({ view, busy, error, post, goto }: StepProps) {
  const [installed, setInstalled] = useState(installState() === 'installed')
  useEffect(() => onInstallChange(() => setInstalled(installState() === 'installed')), [])

  const required = view.checklist.filter((i) => i.required)
  const recommended = view.checklist.filter((i) => !i.required)
  const doneCount = required.filter((i) => i.done).length

  return (
    <div className="anim-rise">
      <p className="text-[15px] leading-relaxed text-ink-mute" data-testid="checklist-summary">
        {view.canComplete
          ? 'Everything needed is in place.'
          : `${doneCount} of ${required.length} required items done. Finish the rest and you are set.`}
      </p>

      <ul className="card mt-5 divide-y divide-line-soft p-0" data-testid="checklist">
        {required.map((item) => (
          <Line key={item.key} item={item} onFix={FIX[item.key] ? () => goto(FIX[item.key]!) : undefined} />
        ))}
        {recommended.map((item) => (
          <Line key={item.key} item={item} />
        ))}
        {/* This phone's own fact, not the server's. */}
        <Line
          item={{
            key: 'installed',
            label: 'Added to home screen',
            done: installed,
            required: false,
            detail: installed ? undefined : 'Recommended. Open Allstar from its own icon and it works without signal.',
          }}
        />
      </ul>

      {error && (
        <p role="alert" className="mt-4 rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad">
          {error}
        </p>
      )}

      <Button
        size="lg"
        full
        className="mt-6"
        disabled={!view.canComplete || busy}
        onClick={() => void post('checklist')}
        data-testid="checklist-complete"
      >
        {busy ? 'Finishing…' : 'Complete setup'}
      </Button>
      {!view.canComplete && (
        <p className="mt-2 text-center text-[12.5px] text-ink-mute">The required lines above have to be done first.</p>
      )}
    </div>
  )
}

function Line({ item, onFix }: { item: ChecklistItemDTO; onFix?: () => void }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid="checklist-item" data-key={item.key} data-done={item.done} data-required={item.required}>
      <span
        className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full icon-sm ${
          item.done ? 'bg-good text-surface-sunk' : 'border border-line text-transparent'
        }`}
        aria-hidden
      >
        {item.done ? <IconCheck /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[15px] ${item.done ? 'text-ink' : 'font-medium text-ink'}`}>
          {item.label}
          {!item.required && <span className="ml-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-mute">Recommended</span>}
        </p>
        {item.detail && !item.done && <p className="mt-0.5 text-[13px] leading-snug text-ink-mute">{item.detail}</p>}
      </div>
      {!item.done && onFix && (
        <button type="button" onClick={onFix} className="focusable min-h-tap shrink-0 rounded-lg px-3 text-[13.5px] font-semibold text-accent">
          Fix
        </button>
      )}
    </li>
  )
}
