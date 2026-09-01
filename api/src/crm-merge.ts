/**
 * What an inbound GoHighLevel change is allowed to do to a lead we already have.
 *
 * The conflict rule is that **Allstar wins, absolutely** — on any lead both
 * systems know about, our copy is authoritative and nothing inbound is applied.
 * That was decided knowing the cost: a correction made in GoHighLevel is not
 * merely ignored, it is overwritten by the next push.
 *
 * This file is the one carve-out, and it is not an exception to the rule so much
 * as a case the rule never covered. **Winning requires something to win with.**
 * Where Allstar holds no value at all for a field, there is no disagreement to
 * resolve — an empty phone number is not our position on what the phone number
 * is. So a blank gets filled, and a value never gets replaced.
 *
 * The pairing that makes this worth having: a lead with no phone and no email
 * cannot be pushed at all — GoHighLevel matches an upsert on one of those, so
 * `crm-push.ts` drops it with a reason, and door-to-door lists are full of
 * address-only rows. A phone number arriving from GoHighLevel is exactly what
 * turns one of those from unsendable into sendable.
 *
 * ## What is never filled, and why each one
 *
 * **Lead state** — `status`, `last_outcome`, and Do Not Contact. Allstar owns
 * these outright. `status` also happens never to be blank (it is NOT NULL and
 * defaults to `new`), but it is excluded by rule rather than by accident, because
 * relying on the column default to protect a policy is how a policy stops
 * holding when somebody changes a default.
 *
 * **Do Not Contact** specifically, restated because it is the one that would
 * matter: nothing inbound can reverse it, and it is not reachable from here at
 * all. See `LEGAL.md` question 2.
 *
 * **`address1`** — the identity of the lead. A lead whose address changed is a
 * different house, and quietly moving one would put a rep at the wrong door.
 *
 * **`lat` / `lng`** — these look fillable, because they are NOT NULL with a
 * default of `0` and an unplaced lead therefore sits at 0,0, which reads as
 * blank. They are excluded anyway. Coordinates are ours to derive by geocoding,
 * and taking GoHighLevel's would bypass the company's chosen provider, the spend
 * estimate shown before a lookup runs, and the storage-terms question in
 * `LEGAL.md` question 4. A lead that arrives without a pin gets geocoded; it does
 * not get somebody else's coordinates.
 *
 * The plan this returns cannot express any of those, which is a stronger
 * guarantee than a runtime check: there is no field on `FillPlan` to put them in.
 */

/** The fields of a property a blank-fill may touch. Nothing else is expressible. */
export const FILLABLE_PROPERTY_FIELDS = ['city', 'state', 'zip'] as const

export interface InboundContact {
  firstName?: string | null
  lastName?: string | null
  name?: string | null
  phone?: string | null
  email?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
}

export interface LocalLead {
  propertyId: string
  city?: string | null
  state?: string | null
  zip?: string | null
  /** Null when the property has no contact row at all — the common case. */
  contact?: { id: string; name: string; phone?: string | null; email?: string | null } | null
}

export interface FillPlan {
  /** Only ever the keys in FILLABLE_PROPERTY_FIELDS, and only ever blanks. */
  property: { city?: string; state?: string; zip?: string }
  contact:
    | { action: 'none' }
    | { action: 'update'; id: string; phone?: string; email?: string }
    | { action: 'create'; name: string; phone?: string; email?: string }
  /**
   * What was filled, in words, for the audit log and for an admin asking why a
   * lead changed without a rep touching it. Empty means nothing was applied.
   */
  filled: string[]
}

/**
 * Blank means absent, not falsy.
 *
 * Every field here is a string, so this is only about empty and whitespace — but
 * written as its own function because the day a numeric field joins the list,
 * `!value` would treat a genuine `0` as missing and quietly overwrite it.
 */
function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === ''
}

/** Trimmed, or undefined if there is nothing there. */
function take(value: string | null | undefined): string | undefined {
  if (blank(value)) return undefined
  return (value as string).trim()
}

/** Their name fields are inconsistent; accept whichever arrived. */
function incomingName(incoming: InboundContact): string | undefined {
  const joined = [take(incoming.firstName), take(incoming.lastName)].filter(Boolean).join(' ')
  return take(incoming.name) ?? (joined || undefined)
}

/**
 * Work out what, if anything, an inbound contact may fill in.
 *
 * Pure, so the rule can be tested exhaustively without a database or a webhook —
 * which matters because this is the part of the sync that will be reasoned about
 * long after it is written, and the part where a quiet mistake overwrites a
 * customer's data rather than failing loudly.
 */
export function planInboundFill(local: LocalLead, incoming: InboundContact): FillPlan {
  const plan: FillPlan = { property: {}, contact: { action: 'none' }, filled: [] }

  /* --- the property's own blanks ----------------------------------------- */

  const propertyFills: Array<[keyof FillPlan['property'], string | undefined, string | null | undefined]> = [
    ['city', take(incoming.city), local.city],
    ['state', take(incoming.state), local.state],
    ['zip', take(incoming.postalCode), local.zip],
  ]
  for (const [field, incomingValue, localValue] of propertyFills) {
    if (incomingValue && blank(localValue)) {
      plan.property[field] = incomingValue
      plan.filled.push(field)
    }
  }

  /* --- the contact ------------------------------------------------------- */

  const phone = take(incoming.phone)
  const email = take(incoming.email)

  if (!local.contact) {
    /*
      No contact row at all, so there is nothing of ours to disagree with. Worth
      creating only if something useful arrived: a row carrying a name and no way
      to reach anybody leaves the lead exactly as unsendable as it was, while
      making it look like it gained something.
    */
    if (phone || email) {
      plan.contact = {
        action: 'create',
        name: incomingName(incoming) ?? 'Unknown',
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
      }
      plan.filled.push(...[phone ? 'phone' : null, email ? 'email' : null].filter((x): x is string => !!x))
    }
    return plan
  }

  // A contact exists. Its name is NOT NULL and so is never blank — there is
  // nothing to fill there, and replacing it would be the rule this file exists
  // to respect.
  const update: { phone?: string; email?: string } = {}
  if (phone && blank(local.contact.phone)) update.phone = phone
  if (email && blank(local.contact.email)) update.email = email

  if (update.phone || update.email) {
    plan.contact = { action: 'update', id: local.contact.id, ...update }
    if (update.phone) plan.filled.push('phone')
    if (update.email) plan.filled.push('email')
  }

  return plan
}

/** Nothing to do — useful for a caller deciding whether to write at all. */
export function isNoop(plan: FillPlan): boolean {
  return plan.filled.length === 0
}
