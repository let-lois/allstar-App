import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Field } from '../components/ui/Input'
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
 * Four fields, and the location is pre-filled from GPS — a rep adding a house
 * that isn't in the territory list is standing in front of it, so asking them
 * to type coordinates or search an address would be absurd. Everything else
 * gets filled in during the visit.
 */
export function NewLead() {
  const nav = useNavigate()
  const [address, setAddress] = useState('')
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

  const save = async () => {
    if (!address.trim() || !coords) return
    setSaving(true)
    haptic('confirm')

    const property: Property = {
      id: uid('p'),
      address1: address.trim(),
      city: 'Round Rock',
      state: 'TX',
      zip: '78664',
      lat: coords.lat,
      lng: coords.lng,
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
            <Field
              label="Address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoFocus
              autoComplete="street-address"
              enterKeyHint="next"
              placeholder="123 Main Street"
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
                {locating
                  ? 'Getting your position…'
                  : coords
                    ? `Pinned at ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`
                    : 'Location unavailable — enable location to drop a pin.'}
              </p>
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
          disabled={!address.trim() || !coords || saving}
        >
          {saving ? 'Saving…' : 'Save lead'}
        </Button>
      </div>
    </div>
  )
}
