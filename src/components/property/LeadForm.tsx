import { useEffect, useRef, useState } from 'react'
import { Field } from '../ui/Input'
import { AddressAutocomplete, type PickedAddress } from './AddressAutocomplete'
import { useAppStore, useMyLists } from '../../store/useAppStore'
import { canEditList } from '../../lib/leadLists'
import { reverseGeocode, type ReverseAddress } from '../../lib/reverseGeocode'
import { addressFieldMode } from '../../lib/address'
import { distanceMiles, getPosition, territoryAt } from '../../lib/geo'
import { uid } from '../../lib/id'
import * as db from '../../lib/db'
import { enqueue } from '../../lib/sync'
import { haptic } from '../../lib/haptics'
import type { LeadList, Property } from '../../types'

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
  onPick,
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
  /**
   * A suggestion was picked, and it knows where it is.
   *
   * The map passes this so the pin follows the pick: a rep who tapped roughly
   * the right block and then chose the exact address from the list expects the
   * pin to go to that door, the way it does in every map they have used. Before
   * this the tapped point kept winning and the lead saved a house's address
   * with the neighbour's coordinates.
   */
  onPick?: (at: { lat: number; lng: number }) => void
}) {
  const [address, setAddress] = useState('')
  const [picked, setPickedState] = useState<PickedAddress | null>(null)
  const setPicked = (p: PickedAddress | null) => {
    setPickedState(p)
    if (p) onPick?.({ lat: p.lat, lng: p.lng })
  }
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [locating, setLocating] = useState(!at)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /*
    Which lists the new lead should land on, chosen before it exists.

    Until now a lead went on a list in two steps: save it, then find the Lists
    section on its page and tick. A rep working a re-knock list from a street
    does not want the second step, so the choice is taken here and applied the
    moment the lead has an id — through the same two store actions the lead
    page uses, so there is one rule for who may put a house on which list.
    `newListName` is the "start one" path, exactly as on the lead page.
  */
  const [listIds, setListIds] = useState<string[]>([])
  const [newListName, setNewListName] = useState('')
  /*
    What the map said was here, and whether the rep has since disagreed.

    `touched` is the whole safety rule of this feature: an answer that arrives
    from Google half a second after a rep starts typing must never land on top
    of what they are typing. They are standing in front of the house reading its
    number off the door; Google is guessing from a coordinate. The rep wins, and
    they win permanently — once they have touched the field, no later lookup
    writes to it.
  */
  const [found, setFound] = useState<ReverseAddress | null>(null)
  const [looking, setLooking] = useState(false)
  /** Whether the last answer was actually written into the field, or only offered. */
  const [filled, setFilled] = useState(false)
  const touched = useRef(false)

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
    Ask what is at the pin, once the rep has actually asked for a lead here.

    Keyed on the coordinate rather than run on mount, so moving the pin asks
    again — but through a cache, so moving it back does not. Nothing is asked
    while a rep is only panning the map: this hook exists solely for the form,
    and the form only exists once they have tapped a house.
  */
  useEffect(() => {
    if (!at) return
    let cancelled = false
    setLooking(true)
    void reverseGeocode(at)
      .then((r) => {
        if (cancelled) return
        setFound(r)
        // Only into fields the rep has not touched. See `touched`.
        if (r && !touched.current) {
          setAddress(r.address1)
          setPicked(null)
          setFilled(true)
        } else {
          setFilled(false)
        }
      })
      .finally(() => {
        if (!cancelled) setLooking(false)
      })
    return () => {
      cancelled = true
    }
    // The coordinate, and nothing else. Listing `at` itself would re-run this on
    // every render that rebuilt the object — a fresh billable lookup for a pin
    // that has not moved, which the cache would mostly absorb and should not
    // have to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at?.lat, at?.lng])

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
    /*
      The same door twice.

      A rep who taps a house that is already a lead is shown that lead instead
      (`existing`, below), but one who types the address by hand never sees the
      pin. The same street line and ZIP as a lead already on this phone is the
      same house; saving it again would put two cards on one door and split the
      visit history between them. A different unit is a different line.
    */
    const typed = picked?.address1 ?? address.trim()
    const same = sameAddressLead(typed, picked?.zip ?? found?.zip ?? '')
    if (same) {
      setError(`${same.address1} is already a lead. Open it from the map or the Leads list, or add the unit number if this is a different unit.`)
      return
    }
    setSaving(true)
    setError(null)
    haptic('confirm')

    const property: Property = {
      id: uid('p'),
      address1: picked?.address1 ?? address.trim(),
      /*
        A picked suggestion first, then whatever the map said was at the pin,
        then blank. Blank rather than guessed is still the rule — what has
        changed is that there is now a third thing that is not a guess: the town
        containing the exact point the rep tapped. That is not the hardcoded
        "Round Rock, TX 78664" this used to stamp on every lead; it is derived
        from their own finger.
      */
      city: picked?.city ?? found?.city ?? '',
      state: picked?.state ?? found?.state ?? '',
      zip: picked?.zip ?? found?.zip ?? '',
      lat: pin.lat,
      lng: pin.lng,
      status: 'new',
      score: 50,
      contacts: name.trim()
        ? [{ id: uid('ct'), name: name.trim(), phone: phone.trim() || undefined, isPrimary: true }]
        : [],
      assignedRepId: useAppStore.getState().user?.id,
      // The patch it stands in, by the rule the server applies to the same create.
      territoryId: territoryAt(pin, Object.values(useAppStore.getState().territories))?.id,
    }

    /*
      A write that fails has to say so.

      Without this the button reads "Saving…" for ever: `setSaving(true)` with
      no path back, a disabled control, an open sheet and no lead. The likeliest
      cause is not a bug but a full phone — `db.ts` raises StorageFull by name
      for exactly this, and a rep who has been photographing roofs all week is
      the one it happens to. Silently losing the lead they just typed is the
      worst thing this form could do.
    */
    try {
      await db.put('properties', property)
      useAppStore.setState((s) => ({ properties: { ...s.properties, [property.id]: property } }))
      /*
        Everything the server needs to make the same lead, not just the id.

        The create used to carry `{ id, created: true }` and nothing else, so
        the office got "Untitled property" at 0,0 with nobody in it — and, on
        the rep's next refresh, so did the rep. The address, the pin and the
        homeowner typed at the door travel with it.
      */
      await enqueue('property.status', {
        id: property.id,
        created: true,
        address1: property.address1,
        city: property.city,
        state: property.state,
        zip: property.zip,
        lat: property.lat,
        lng: property.lng,
        contacts: property.contacts,
      })
    } catch (err) {
      setError(
        String(err).includes('StorageFull')
          ? 'This phone is out of space, so the lead was not saved. Free some up and try again.'
          : 'The lead could not be saved on this phone. Try again.',
      )
      setSaving(false)
      return
    }

    /*
      Onto its lists, now that it has an id.

      After the lead is stored and before anything is cleared, so the page the
      caller opens next already shows the list names. A failure here is not a
      failed save: the lead exists on the phone and in the store, and its own
      page carries the same control for a second try — so the error is kept
      out of the way of the navigation rather than shown over a saved lead.
    */
    const store = useAppStore.getState()
    for (const listId of listIds) {
      try {
        await store.updateListMembers(listId, { add: [property.id] })
      } catch {
        // The lead page offers the same tick again.
      }
    }
    if (newListName.trim()) {
      try {
        await store.createList({ name: newListName, propertyIds: [property.id] })
      } catch {
        // As above: the lead is saved; the list can be started from its page.
      }
    }

    /*
      Emptied for the next one, because this hook outlives the sheet.

      `useLeadDraft` is called by `MapScreen`, not by the sheet it fills, so a
      draft survives the sheet closing and is handed to the next lead the rep
      adds. Nothing cleared it, and each leftover field was its own defect:

        `saving` stayed true, so `canSave` stayed false and the button read
        "Saving…" on a form nobody had submitted. A rep could add one lead by
        tapping the map and then could not add another for the rest of the
        session — no error, no explanation, just a dead button.

        `name` and `phone` stayed filled, so tapping a different house offered
        the previous homeowner's name and number as its own. That one is worse
        than a dead button: it does not look broken, and a rep who taps Save
        has attributed one household's details to another address.

        `touched` stayed true, so the reverse geocode stopped filling the
        address in — the second lead onward silently lost the prefill that is
        the whole reason a tap on the map asks Google what is there.

      Cleared before `onSaved`, which is what closes the sheet: the form has to
      be usable again even if the caller throws.
    */
    setSaving(false)
    setAddress('')
    setPicked(null)
    setName('')
    setPhone('')
    setFound(null)
    setFilled(false)
    setError(null)
    // The list choice too: the next house tapped is not on tonight's list
    // just because the last one was.
    setListIds([])
    setNewListName('')
    touched.current = false

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
    found,
    looking,
    filled,
    markTouched: () => {
      touched.current = true
    },
    pin,
    coords,
    locating,
    saving,
    error,
    listIds,
    toggleList: (id: string) =>
      setListIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])),
    newListName,
    setNewListName,
    canSave: !!address.trim() && !!pin && !saving,
    save,
    existing: at ? existingLeadAt(at, found?.address1, found?.zip) : null,
  }
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim()

/** A lead on this phone with the same street line (and ZIP, when both have one). */
function sameAddressLead(address1: string, zip: string): Property | null {
  const a = norm(address1)
  if (!a) return null
  for (const p of Object.values(useAppStore.getState().properties)) {
    if (norm(p.address1) !== a) continue
    if (zip && p.zip && norm(zip) !== norm(p.zip)) continue
    return p
  }
  return null
}

/**
 * The lead already standing where the rep tapped, if there is one.
 *
 * A roof tapped a few metres from an existing pin is that house: the pin sits
 * where somebody tapped last time, not on a surveyed point, so an exact match
 * would miss nearly every real repeat. 15 metres is inside one suburban lot and
 * short of the house next door. The address the map found is checked too, for
 * a lead whose pin was dropped at the kerb.
 */
function existingLeadAt(at: { lat: number; lng: number }, address1?: string, zip?: string): Property | null {
  let best: Property | null = null
  let bestM = 15
  for (const p of Object.values(useAppStore.getState().properties)) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
    const m = distanceMiles(at, p) * 1609.34
    if (m <= bestM) {
      best = p
      bestM = m
    }
  }
  return best ?? (address1 ? sameAddressLead(address1, zip ?? '') : null)
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
  const { at, pin, coords, locating, found, looking, filled, markTouched, error } = draft

  /*
    Sticky for the life of the draft, like `touched`. Having asked to correct
    the address once, a rep who then nudges the pin should not have the field
    snatched back into a read-only line.
  */
  const [editing, setEditing] = useState(false)
  const mode = addressFieldMode({ at: at ?? null, found, filled, editing })

  return (
    <div className="space-y-4">
      {mode === 'confirmed' ? (
        <div
          data-testid="lead-address-confirmed"
          className="rounded-field bg-surface-tint px-3.5 py-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow">Address</p>
              <p className="mt-1 truncate text-[15px] font-semibold">{address}</p>
              {(found?.city || found?.state || found?.zip) && (
                <p className="truncate text-[13px] text-ink-mute">
                  {[found?.city, found?.state, found?.zip].filter(Boolean).join(' ')}
                </p>
              )}
            </div>
            {/*
              Not an icon. This is the escape hatch from an address the app
              guessed, and the rep needs to find it while holding a phone in one
              hand at a door — a pencil glyph is a puzzle at that moment.
            */}
            <button
              type="button"
              onClick={() => {
                // Theirs from here on, so no later lookup overwrites it.
                markTouched()
                setEditing(true)
              }}
              className="focusable min-h-tap shrink-0 rounded-lg px-2 text-sm font-semibold text-accent"
            >
              Change
            </button>
          </div>
          <p className="mt-1.5 text-[12.5px] text-ink-mute">
            From the map — check it against the door.
          </p>
        </div>
      ) : (
      <AddressAutocomplete
        value={address}
        onChange={(v) => {
          // From here on this field is the rep's. See `touched` in useLeadDraft.
          markTouched()
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
              ? addressHint(found, looking, filled)
              : 'Start typing and pick from the list — that sets the pin exactly.'
        }
      />
      )}

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

      <LeadListChoice draft={draft} />

      {error && (
        <p role="alert" className="rounded-field bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
          {error}
        </p>
      )}

      {/*
        Read-only, and stated rather than silent: the pin is the one field the
        rep can't correct by typing, so if GPS hasn't answered yet they need to
        see that before the save button refuses them.
      */}
      <div className="rounded-field bg-surface-tint px-3.5 py-3" data-testid="lead-pin-readout">
        <p className="eyebrow">Location</p>
        <p className="nums mt-1 text-[13px] text-ink-soft">
          {at && picked && at.lat === picked.lat && at.lng === picked.lng
            ? `Pinned on the address — ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}`
            : at
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
            {[found?.city, found?.state, found?.zip].filter(Boolean).length > 0
              ? `${[found?.city, found?.state, found?.zip].filter(Boolean).join(' ')} · tap the map again to move it.`
              : 'Tap the map again to move it.'}
          </p>
        )}
      </div>

    </div>
  )
}

/**
 * "Add to list", on the form rather than after it.
 *
 * The same shape as the control on a lead's page — a line saying where the
 * lead is going and one button that opens the picker — so a rep learns it once.
 * The difference is when it applies: nothing is written until Save, because
 * there is no lead yet to write about. Only lists this person may edit are
 * offered, for the reason given on `ListMembership`: a list the office handed
 * them is theirs to work, not to change, and the server would refuse the add.
 */
function LeadListChoice({ draft }: { draft: LeadDraft }) {
  const user = useAppStore((s) => s.user)
  const mine = useMyLists()
  const editable = mine.filter((l) => canEditList(user, l))
  const { listIds, toggleList, newListName, setNewListName, saving } = draft
  const [open, setOpen] = useState(false)

  if (!user) return null

  const chosen = editable.filter((l) => listIds.includes(l.id))
  const summary = describeListChoice(chosen, newListName)

  return (
    <div data-testid="lead-list-choice">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft" data-testid="lead-list-summary">
          {summary}
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="focusable ml-auto min-h-[44px] rounded-lg px-2 text-[13px] font-semibold text-accent"
        >
          {open ? 'Done' : 'Add to list'}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2 rounded-field bg-surface-sunk px-3 py-2.5" data-testid="lead-list-picker">
          {editable.length === 0 ? (
            <p className="text-[12.5px] text-ink-mute">
              You have no lists of your own yet. Start one below and this lead goes on it when you save.
            </p>
          ) : (
            <ul className="space-y-1">
              {editable.map((l) => (
                <li key={l.id}>
                  <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[14px]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-500"
                      checked={listIds.includes(l.id)}
                      disabled={saving}
                      onChange={() => toggleList(l.id)}
                    />
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                    <span className="nums text-[12px] text-ink-mute">{l.leadIds.length}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <Field
            label="New list"
            hint="Optional. Made when you save, with this lead on it."
            value={newListName}
            disabled={saving}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="e.g. Come back Saturday"
          />
        </div>
      )}
    </div>
  )
}

/** The one line above the picker: where this lead will go when saved. */
function describeListChoice(chosen: Pick<LeadList, 'name'>[], newListName: string): string {
  const names = chosen.map((l) => l.name)
  const fresh = newListName.trim()
  if (fresh) names.push(`${fresh} (new)`)
  if (names.length === 0) return 'Not on a list'
  return `Goes on ${names.join(', ')}`
}

/**
 * What to say under the address field when the pin came from the map.
 *
 * Three states, and the middle one is why this is a function rather than a
 * string. Google can answer precisely, vaguely, or not at all — and a rep told
 * nothing cannot tell "we could not find this street" from "this app does not
 * do that". A vague answer says which half is missing and whose job it now is.
 */
function addressHint(found: ReverseAddress | null, looking: boolean, filled: boolean): string {
  if (looking) return 'Looking up the address at this pin…'
  /*
    `filled`, not just `found`. Once the rep has typed here the field is theirs
    and no lookup writes to it — so saying "filled in from the map" would be
    claiming credit for text they wrote themselves, which is a small lie that
    makes them doubt the rest of the form.
  */
  if (found?.address1 && filled) return 'Filled in from the map — check it against the door.'
  if (found?.address1) return 'Kept what you typed. The map says this is ' + found.address1 + '.'
  if (found) return 'Only the area came back, not the street. Type the number and street.'
  return 'House number and street. The pin is already set where you tapped.'
}
