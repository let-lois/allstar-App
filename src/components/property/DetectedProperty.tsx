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
export function DetectedProperty({ draft }: { draft: LeadDraft }) {
  const { at, found, looking } = draft
  if (!at) return null
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
