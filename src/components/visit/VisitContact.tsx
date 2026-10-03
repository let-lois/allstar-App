import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { Property } from '../../types'

/**
 * The homeowner's name, number and email, editable during the visit.
 *
 * The lead used to say "add a name and number during your visit" and then give
 * the visit no way to do it — the rep had to leave the visit, open Edit details
 * and come back. These are the same fields Edit details writes (the lead's
 * primary contact, through `updateLeadDetails`), so nothing here is a second
 * copy: a save changes the lead, and the lead, the office console and search
 * all show it.
 *
 * All optional. A number without a name is still worth keeping, so it is saved
 * under "Contact" until somebody learns the name.
 *
 * `flushRef` lets the visit save anything typed but not yet saved when the rep
 * finishes, so pressing Complete never quietly drops a phone number.
 */
export function VisitContact({
  property,
  encourage,
  flushRef,
}: {
  property: Property
  /** An outcome worth following up on: say why the fields matter, without blocking. */
  encourage?: boolean
  flushRef?: MutableRefObject<(() => Promise<void>) | null>
}) {
  const updateLeadDetails = useAppStore((s) => s.updateLeadDetails)
  const contact = property.contacts.find((c) => c.isPrimary) ?? property.contacts[0]
  const [name, setName] = useState(contact?.name ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const dirty =
    name.trim() !== (contact?.name ?? '').trim() ||
    phone.trim() !== (contact?.phone ?? '').trim() ||
    email.trim() !== (contact?.email ?? '').trim()
  const empty = !name.trim() && !phone.trim() && !email.trim()

  const save = async () => {
    if (!dirty) return
    // Clearing every field of a contact that never existed is nothing to save.
    if (empty && !contact) return
    setState('saving')
    setError(null)
    try {
      await updateLeadDetails(property.id, {
        contact: {
          name: name.trim() || (phone.trim() || email.trim() ? 'Contact' : ''),
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
        },
      })
      if (!name.trim() && (phone.trim() || email.trim())) setName('Contact')
      setState('saved')
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'Could not save the contact.')
    }
  }

  // The latest `save`, for the visit to call when it finishes.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!flushRef) return
    flushRef.current = () => saveRef.current()
    return () => {
      flushRef.current = null
    }
  }, [flushRef])

  /*
    Leaving the step is a save too. This card lives on the Details step, and
    Continue unmounts it — which took the flush above with it, so a rep who
    typed a number and pressed Continue instead of Save lost it at Complete.
    Reported from the field as a contact that "didn't take". `save` returns
    early when nothing changed, so this costs nothing on an untouched card.
  */
  useEffect(() => () => void saveRef.current().catch(() => {}), [])

  useEffect(() => {
    if (dirty && state === 'saved') setState('idle')
  }, [dirty, state])

  const field =
    'focusable min-h-tap w-full rounded-field border border-line bg-surface px-3 text-[16px] text-ink placeholder:text-ink-mute'

  return (
    <section data-testid="visit-contact" aria-labelledby="visit-contact-title" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="visit-contact-title" className="text-[13px] font-semibold uppercase tracking-wide text-ink-mute">
          Contact
        </h2>
        {state === 'saved' && !dirty && <span className="text-[12.5px] font-semibold text-good">Saved to lead</span>}
      </div>
      {encourage && !contact && empty && (
        <p className="text-[13px] text-ink-soft">Add their name and number so you can follow up. Optional.</p>
      )}
      <label className="block">
        <span className="sr-only">Name</span>
        <input
          data-testid="visit-contact-name"
          className={field}
          placeholder="Name"
          autoComplete="name"
          autoCapitalize="words"
          enterKeyHint="next"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="sr-only">Phone</span>
        <input
          data-testid="visit-contact-phone"
          className={field}
          placeholder="Phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          enterKeyHint="next"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="sr-only">Email</span>
        <input
          data-testid="visit-contact-email"
          className={field}
          placeholder="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      {dirty && (
        <button
          type="button"
          data-testid="visit-contact-save"
          onClick={() => void save()}
          disabled={state === 'saving'}
          /*
            The brand's primary button, not a grey one. It only appears once
            something has changed, and as a grey bar it read as decoration —
            reps typed a number and moved on. Continue saves it anyway (above);
            this makes saving now the obvious move.
          */
          className="metal metal-brand press focusable min-h-tap w-full rounded-field text-[15px] font-semibold disabled:opacity-60"
        >
          {state === 'saving' ? 'Saving…' : 'Save contact to lead'}
        </button>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
    </section>
  )
}
