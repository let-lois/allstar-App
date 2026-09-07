import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Field } from '../ui/Input'
import { addressAt } from '../../lib/reverse'
import { useAppStore } from '../../store/useAppStore'
import { uid } from '../../lib/id'
import * as db from '../../lib/db'
import { enqueue } from '../../lib/sync'
import { haptic } from '../../lib/haptics'
import type { PickedAddress } from './AddressAutocomplete'
import type { Property } from '../../types'

/**
 * Confirm a pin the rep just dropped on a house, and turn it into a lead.
 *
 * The other half of tap-to-place. `MapScreen` owns arming the mode and holds the
 * coordinate; this owns everything between that coordinate and a saved property
 * the rep can start filling in.
 *
 * Three rules, in the order they matter:
 *
 * **The pin is already good.** It is exactly where the rep pointed, so nothing
 * here can block on a lookup. The sheet opens immediately with the coordinate
 * shown and the address arriving a moment later — or not arriving, which is a
 * state this screen is designed for rather than one it treats as broken.
 *
 * **The address is a suggestion, not an answer.** Reverse geocoding on a
 * duplex, a corner lot or a long driveway is regularly one house out, and the
 * rep is standing in front of the right one. So it lands in an editable field
 * rather than being written to the lead behind their back, and correcting it
 * costs one tap.
 *
 * **Editing the street does not move the pin.** The coordinate is the thing the
 * rep cannot type and the thing the map needs; the text is a label on it. This
 * is the opposite of `NewLead`, where picking an address *sets* the pin, and the
 * difference is which one the rep chose deliberately.
 */
export function DropPinSheet({
  at,
  onSaved,
  onCancel,
}: {
  at: { lat: number; lng: number }
  onSaved: (propertyId: string) => void
  onCancel: () => void
}) {
  const [address, setAddress] = useState('')
  const [found, setFound] = useState<PickedAddress | null>(null)
  const [looking, setLooking] = useState(true)
  const [saving, setSaving] = useState(false)

  /*
    Keyed on the coordinate by the caller, so a second pin is a fresh sheet
    rather than this one with someone else's address still in the field.
  */
  useEffect(() => {
    let cancelled = false
    void addressAt(at.lat, at.lng).then((a) => {
      if (cancelled) return
      setFound(a)
      // Only pre-fills an empty field: a rep who started typing while the lookup
      // was in flight has already answered the question it was asking.
      if (a) setAddress((cur) => cur || a.address1)
      setLooking(false)
    })
    return () => {
      cancelled = true
    }
  }, [at.lat, at.lng])

  const save = async () => {
    if (!address.trim()) return
    setSaving(true)
    haptic('confirm')

    /*
      City, state and ZIP come from the lookup or stay blank — never guessed,
      the same rule `NewLead` follows. A rep who corrected the street keeps the
      lookup's town, which is right: being one house out on a street does not
      make the town wrong, and it is the one part of an address a rep standing
      outside cannot check.
    */
    const property: Property = {
      id: uid('p'),
      address1: address.trim(),
      city: found?.city ?? '',
      state: found?.state ?? '',
      zip: found?.zip ?? '',
      lat: at.lat,
      lng: at.lng,
      status: 'new',
      score: 50,
      contacts: [],
      assignedRepId: useAppStore.getState().user?.id,
    }

    // Same write path as every other field-created lead: durable first, state
    // second, queued third. Nothing here waits on the network.
    await db.put('properties', property)
    useAppStore.setState((s) => ({ properties: { ...s.properties, [property.id]: property } }))
    await enqueue('property.status', { id: property.id, created: true })

    onSaved(property.id)
  }

  return (
    <div className="space-y-4 px-4 pb-2">
      <div>
        <p className="eyebrow">New pin</p>
        <p className="mt-1 text-[13px] text-ink-mute">
          Dropped where you tapped. Check the address, then start the visit.
        </p>
      </div>

      <Field
        label="Address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder={looking ? 'Looking up the address…' : 'Type the address'}
        autoComplete="off"
        enterKeyHint="done"
        hint={
          looking
            ? 'Looking it up from the map…'
            : found
              ? [found.city, found.state, found.zip].filter(Boolean).join(' ') ||
                'Found the street. Fill in the rest later.'
              : /*
                  Named rather than silent. A blank field with no explanation
                  reads as a broken lookup, and the rep needs to know the pin is
                  fine and only the label is missing.
                */
                'Couldn’t look it up — no signal, or the address isn’t listed. Type it and the pin still saves.'
        }
      />

      <div className="rounded-field bg-surface-tint px-3.5 py-3">
        <p className="eyebrow">Pin</p>
        <p className="nums mt-1 text-[13px] text-ink-soft">
          {at.lat.toFixed(5)}, {at.lng.toFixed(5)}
        </p>
        <p className="mt-1 text-[12.5px] text-ink-mute">
          Exactly where you tapped. Editing the address won’t move it.
        </p>
      </div>

      <div className="flex gap-2">
        <Button variant="secondary" size="lg" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="lg"
          className="flex-1"
          onClick={() => void save()}
          disabled={!address.trim() || saving}
        >
          {saving ? 'Saving…' : 'Save & open'}
        </Button>
      </div>
    </div>
  )
}
