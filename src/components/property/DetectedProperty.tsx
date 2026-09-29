import { StatusBadge } from '../ui/StatusBadge'
import { PropertyImage } from './StreetView'
import { cityLine } from '../../lib/format'
import type { LeadDraft } from './LeadForm'

/**
 * A house that is not a lead yet — what the map found there, before a form.
 *
 * Tapping a roof used to open the Add-lead form straight away, address already
 * typed in. That is efficient and it is also a form: the first thing a rep saw
 * for the house they had just pointed at was three input boxes. This is the
 * step before it. The address Google found, the photo of the house, the plain
 * fact that nobody has recorded it yet, and one button. The form comes when
 * they ask for it, with everything here already filled in.
 *
 * Nothing on this sheet is a claim the app cannot back: while the lookup runs
 * it says so, and if Google has nothing the title says that too, and the
 * button still leads to a form they can type into.
 */
export function DetectedProperty({ draft, onAddAnyway }: { draft: LeadDraft; onAddAnyway?: () => void }) {
  const { at, found, looking, existing } = draft
  if (!at) return null
  /*
    Already a lead.

    The pin of an existing lead is meant to open that lead, but a roof tapped
    beside the pin, or a house whose pin sits at the kerb, lands here instead.
    Saying "Not a lead yet" about a door that is one is how the same house ends
    up with two cards. So the sheet says whose door it is, and the button below
    opens it; a second unit at the same spot is still one tap away.
  */
  if (existing) {
    return (
      <div className="space-y-3 pt-1" data-testid="detected-property" data-state="existing">
        <div>
          <h3 className="text-lg font-semibold leading-tight">{existing.address1}</h3>
          <p className="text-sm text-ink-mute">{cityLine(existing)}</p>
        </div>
        <PropertyImage lat={existing.lat} lng={existing.lng} address={existing.address1} className="mt-0" />
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="brand">Already a lead</StatusBadge>
        </div>
        {onAddAnyway && (
          <button
            onClick={onAddAnyway}
            data-testid="detected-add-anyway"
            className="focusable min-h-tap rounded-lg px-1 text-sm font-semibold text-accent"
          >
            A different unit here? Add it as its own lead
          </button>
        )}
      </div>
    )
  }
  const title = looking
    ? 'Finding the address…'
    : found?.address1 || (found ? cityLine(found) || 'Address not found' : 'Address not found')
  const subtitle = found?.address1
    ? cityLine(found)
    : looking
      ? 'One moment.'
      : 'Add lead to type the address yourself.'

  return (
    <div className="space-y-3 pt-1" data-testid="detected-property" data-state={looking ? 'looking' : found ? 'found' : 'none'}>
      <div>
        <h3 className="text-lg font-semibold leading-tight">{title}</h3>
        {subtitle && <p className="text-sm text-ink-mute">{subtitle}</p>}
      </div>

      <PropertyImage lat={at.lat} lng={at.lng} address={found?.address1 ?? 'this house'} className="mt-0" />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="neutral">Not a lead yet</StatusBadge>
        <span className="nums text-xs text-ink-mute">
          {at.lat.toFixed(5)}, {at.lng.toFixed(5)}
        </span>
      </div>
      <p className="text-[12.5px] text-ink-mute">Tap the map again to move the pin.</p>
    </div>
  )
}
