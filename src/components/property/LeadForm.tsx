import { useEffect, useRef, useState } from 'react'
import { Field } from '../ui/Input'
import { AddressAutocomplete, type PickedAddress } from './AddressAutocomplete'
import { useAppStore } from '../../store/useAppStore'
import { getPosition } from '../../lib/geo'
import { uid } from '../../lib/id'
import * as db from '../../lib/db'
import { enqueue } from '../../lib/sync'
import { haptic } from '../../lib/haptics'
import type { Property } from '../../types'

/**
 * Adding one lead, wherever the rep started from — the state and the save.
 *
 * Lifted out of the Add-lead screen when the map learned to open the same form
 * over a tapped house. Two copies of "what a new lead needs" would have drifted
 * within a week — and the interesting part, where the pin comes from, is
 * exactly the part that differs between the two callers, so it is the one thing
 * this asks for rather than deciding.
 *
 * There are now three ways the pin gets set, in descending order of how much it
 * can be trusted:
 *
 * **Tapped on the map.** The rep pointed at the roof. Passed in as `at`, and it
 * wins over everything, including GPS — they are standing in the street looking
 * at the house, and the house is where the lead goes.
 *
 * **Picked from address suggestions.** The address carries its own coordinates
 * and a real city, state and ZIP. Needs no location permission at all, which is
 * what keeps this usable on a phone that has blocked it.
 *
 * **Typed, with GPS.** The rep's own position becomes the pin — accurate enough
 * to walk back to, and all this form had before.
 *
 * What it never does is invent an address. It used to write `Round Rock, TX
 * 78664` onto every lead added from the field regardless of where the rep was
 * standing — fine while there was one territory in one town, wrong the moment
 * there are two. A typed address saves with its city, state and ZIP blank,
 * because blank is a thing the office can see and fix, and a confidently wrong
 * town is not.
 */
export function useLeadDraft({
  at,
  onSaved,
}: {
  /**
   * A location the caller already has — the map's tapped point.
   *
   * Its presence also means no location permission is asked for: the question
   * this form needs answered has already been answered by a finger.
   */
  at?: { lat: number; lng: number } | null
  /** The saved lead. The caller decides where to go next; see the two callers. */
  onSaved: (property: Property) => void
}) {
  const [address, setAddress] = useState('')
  const [picked, setPicked] = useState<PickedAddress | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [locating, setLocating] = useState(!at)
  const [saving, setSaving] = useState(false)

  const storePosition = useAppStore((s) => s.position)

  /*
    The fallback, read at answer time rather than depended on.

    This effect used to list `storePosition` among its dependencies, which meant
    it re-ran every time the shared watcher produced a fix — every few seconds
    for a rep who is walking — and asked for the position again each time. On a
    browser where nobody has made a persistent choice, every one of those is
    another permission prompt.
  */
  const fallback = useRef(storePosition)
  fallback.current = storePosition

  useEffect(() => {
    // Nothing to ask: the pin came from the map. Skipping the whole geolocation
    // path here is the difference between a permission prompt and none on the
    // flow a rep will use most.
    if (at) return
    let cancelled = false
    void getPosition().then((p) => {
      if (cancelled) return
      setCoords(p ? { lat: p.lat, lng: p.lng } : fallback.current)
      setLocating(false)
    })
    return () => {
      cancelled = true
    }
    // Once, on mount. Where the rep is standing when they open the form is the
    // question; a fix arriving later does not change which lead they are adding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
    The tapped point first, then a picked address, then GPS.

    A picked address beats GPS because it is the rooftop rather than wherever
    the rep is standing, which on a wide lot or a shared driveway is a different
    house. A tapped point beats both because the rep chose it deliberately while
    looking at the map — and because they can watch it, which is not true of
    either of the others.
  */
  const pin = at ?? (picked ? { lat: picked.lat, lng: picked.lng } : coords)

  const save = async () => {
    if (!address.trim() || !pin) return
    setSaving(true)
    haptic('confirm')

    const property: Property = {
      id: uid('p'),
      address1: picked?.address1 ?? address.trim(),
      // Blank rather than guessed — see the note on this component.
      city: picked?.city ?? '',
      state: picked?.state ?? '',
      zip: picked?.zip ?? '',
      lat: pin.lat,
      lng: pin.lng,
      status: 'new',
      score: 50,
      contacts: name.trim()
        ? [{ id: uid('ct'), name: name.trim(), phone: phone.trim() || undefined, isPrimary: true }]
        : [],
      assignedRepId: useAppStore.getState().user?.id,
    }

    await db.put('properties', property)
    useAppStore.setState((s) => ({ properties: { ...s.properties, [property.id]: property } }))
    await enqueue('property.status', { id: property.id, created: true })

    onSaved(property)
  }

  return {
    address,
    setAddress,
    picked,
    setPicked,
    name,
    setName,
    phone,
    setPhone,
    at: at ?? null,
    pin,
    coords,
    locating,
    saving,
    canSave: !!address.trim() && !!pin && !saving,
    save,
  }
}

export type LeadDraft = ReturnType<typeof useLeadDraft>

/**
 * The fields, without deciding where the save button goes.
 *
 * Split from the state above because that is the one thing the two callers
 * genuinely disagree about: the Add-lead screen pins its button to the bottom
 * of the viewport, outside the scrolling area, and the map's sheet pins its own
 * to the bottom of the sheet. A shared component that rendered the button would
 * have had to own both layouts, and a form whose primary action scrolls away on
 * a phone is not a trade worth making to save a prop.
 */
export function LeadFields({
  draft,
  autoFocus = true,
}: {
  draft: LeadDraft
  /** Passed to the address field. Off for the map's sheet — see there. */
  autoFocus?: boolean
}) {
  const { address, setAddress, picked, setPicked, name, setName, phone, setPhone } = draft
  const { at, pin, coords, locating } = draft

  return (
    <div className="space-y-4">
      <AddressAutocomplete
        value={address}
        onChange={(v) => {
          setAddress(v)
          // Editing after a pick makes the pick stale — the coordinates would
          // still be the old house's.
          if (picked && v !== picked.address1) setPicked(null)
        }}
        onPick={setPicked}
        near={pin}
        autoFocus={autoFocus}
        hint={
          picked
            ? `${[picked.city, picked.state, picked.zip].filter(Boolean).join(' ')}`
            : at
              ? 'House number and street. The pin is already set where you tapped.'
              : 'Start typing and pick from the list — that sets the pin exactly.'
        }
      />

      <Field
        label="Contact name"
        hint="Optional — you can add it during the visit."
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoComplete="name"
      />

      <Field
        label="Phone"
        hint="Optional."
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        enterKeyHint="done"
      />

      {/*
        Read-only, and stated rather than silent: the pin is the one field the
        rep can't correct by typing, so if GPS hasn't answered yet they need to
        see that before the save button refuses them.
      */}
      <div className="rounded-field bg-surface-tint px-3.5 py-3" data-testid="lead-pin-readout">
        <p className="eyebrow">Location</p>
        <p className="nums mt-1 text-[13px] text-ink-soft">
          {at
            ? `Pinned where you tapped — ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}`
            : picked
              ? `Pinned on the address — ${pin!.lat.toFixed(5)}, ${pin!.lng.toFixed(5)}`
              : locating
                ? 'Getting your position…'
                : coords
                  ? `Pinned at your location — ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`
                  : 'No pin yet.'}
        </p>
        {/*
          The old screen just disabled Save and said nothing, so a rep whose
          browser had silently blocked location had no way to know why the
          button was dead or what to do about it. Both fixes are named, and the
          first one does not need any permission at all.
        */}
        {!at && !picked && !locating && !coords && (
          <p className="mt-1.5 text-[12.5px] text-warn">
            Pick the address from the suggestions above to set the pin, or turn on location for
            this site in your browser settings.
          </p>
        )}
        {at && (
          <p className="mt-1.5 text-[12.5px] text-ink-mute">
            Tap the map again to move it.
          </p>
        )}
      </div>

    </div>
  )
}
