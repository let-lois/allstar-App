import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
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

      <div className="scroll-pane bg-surface-sunk p-3">
        <div className="card space-y-4 p-4">
          <label className="block">
            <span className="text-sm font-semibold">Address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoFocus
              autoComplete="street-address"
              enterKeyHint="next"
              placeholder="123 Main Street"
              className="focusable mt-1 min-h-[52px] w-full rounded-xl border border-slate-200 px-3 text-base"
            />
          </label>

          <label className="block">
            <span className="text-sm font-semibold">
              Contact name <span className="font-normal text-ink-mute">(optional)</span>
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className="focusable mt-1 min-h-[52px] w-full rounded-xl border border-slate-200 px-3 text-base"
            />
          </label>

          <label className="block">
            <span className="text-sm font-semibold">
              Phone <span className="font-normal text-ink-mute">(optional)</span>
            </span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="done"
              className="focusable mt-1 min-h-[52px] w-full rounded-xl border border-slate-200 px-3 text-base"
            />
          </label>

          <div className="rounded-xl bg-surface-sunk p-3 text-sm">
            <p className="font-semibold">Location</p>
            <p className="nums mt-0.5 text-xs text-ink-mute">
              {locating
                ? 'Getting your position…'
                : coords
                  ? `Pinned at ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`
                  : 'Location unavailable — enable location to drop a pin.'}
            </p>
          </div>
        </div>
      </div>

      <div
        className="shrink-0 border-t border-slate-200 bg-surface px-4 pt-3"
        style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
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
