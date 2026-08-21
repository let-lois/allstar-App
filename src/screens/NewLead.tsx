import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Field } from '../components/ui/Input'
import { AddressAutocomplete, type PickedAddress } from '../components/property/AddressAutocomplete'
import { useAppStore } from '../store/useAppStore'
import { getPosition } from '../lib/geo'
import { uid } from '../lib/id'
import * as db from '../lib/db'
import { enqueue } from '../lib/sync'
import { haptic } from '../lib/haptics'
import type { Property } from '../types'

/**
 * Add a lead from the field.
 *
 * A rep adding a house that isn't in the territory list is standing in front of
 * it, so this asks for as little as possible and fills in the rest.
 *
 * There are two ways the pin gets set, and the difference matters:
 *
 * **Picked from suggestions.** The address carries its own coordinates and a
 * real city, state and ZIP. This is the good path — it does not need GPS at all,
 * which is what makes the screen usable on a phone that has blocked location.
 *
 * **Typed, with GPS.** The rep's own position becomes the pin. Accurate enough
 * to walk back to, and all this screen had before.
 *
 * What it no longer does is invent an address. It used to write `Round Rock, TX
 * 78664` onto every lead added from the field, regardless of where the rep was
 * standing — fine while there was one territory in one town, wrong the moment
 * there are two. A typed address now saves with its city, state and ZIP blank,
 * because blank is a thing the office can see and fix, and a confidently wrong
 * town is not.
 */
export function NewLead() {
  const nav = useNavigate()
  const [address, setAddress] = useState('')
  const [picked, setPicked] = useState<PickedAddress | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [locating, setLocating] = useState(true)
  const [saving, setSaving] = useState(false)

  const storePosition = useAppStore((s) => s.position)

  useEffect(() => {
    let cancelled = false
    void getPosition().then((p) => {
      if (cancelled) return
      setCoords(p ? { lat: p.lat, lng: p.lng } : storePosition)
      setLocating(false)
    })
    return () => {
      cancelled = true
    }
  }, [storePosition])

  /*
    A picked address beats GPS: it is the rooftop rather than wherever the rep is
    standing, which on a wide lot or a shared driveway is a different house.
  */
  const pin = picked ? { lat: picked.lat, lng: picked.lng } : coords

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

    nav(`/property/${property.id}`, { replace: true })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Add lead" back />

      <div className="scroll-pane bg-surface-sunk px-4 py-4">
        <div className="content-col">
          <Card className="space-y-4">
            <AddressAutocomplete
              value={address}
              onChange={(v) => {
                setAddress(v)
                // Editing after a pick makes the pick stale — the coordinates
                // would still be the old house's.
                if (picked && v !== picked.address1) setPicked(null)
              }}
              onPick={setPicked}
              near={coords}
              hint={
                picked
                  ? `${[picked.city, picked.state, picked.zip].filter(Boolean).join(' ')}`
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
              Read-only, and stated rather than silent: the pin is the one field
              the rep can't correct by typing, so if GPS hasn't answered yet they
              need to see that before the save button refuses them.
            */}
            <div className="rounded-field bg-surface-tint px-3.5 py-3">
              <p className="eyebrow">Location</p>
              <p className="nums mt-1 text-[13px] text-ink-soft">
                {picked
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
                button was dead or what to do about it. Both fixes are named, and
                the first one does not need any permission at all.
              */}
              {!picked && !locating && !coords && (
                <p className="mt-1.5 text-[12.5px] text-warn">
                  Pick the address from the suggestions above to set the pin, or turn on
                  location for this site in your browser settings.
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>

      <div
        className="shrink-0 bg-surface px-4 pt-3.5 shadow-nav"
        style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
      >
        <Button
          size="lg"
          full
          onClick={() => void save()}
          disabled={!address.trim() || !pin || saving}
        >
          {saving ? 'Saving…' : 'Save lead'}
        </Button>
      </div>
    </div>
  )
}
