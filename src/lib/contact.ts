import type { Contact, LeadStatus, Property } from '../types'
import { telHref } from './format'

/**
 * The only sanctioned way to build a contact link to a homeowner.
 *
 * A rep can close a visit with **Do Not Contact**. It is terminal, it shows a ⊘,
 * it drops the property out of pipeline counts and out of route building. What it
 * did not do was stop the app offering to contact them: `CommActions` rendered
 * one-tap Call, Text and Email without ever reading `property.status`, and
 * `PropertyRow` offered swipe-left-to-call from any list. Marking a household Do
 * Not Contact changed the reports and nothing else.
 *
 * Patching those two call sites would not have been the fix. There were four
 * paths to a live `tel:` and one of them — the swipe — was added later by
 * somebody who had no reason to know a check existed. A fifth will be added.
 *
 * So the check moved into the type instead. `smsHref` and `mailHref` are no
 * longer exported from `format.ts`; they live here, private, and the only way out
 * of this module is a function that takes the **property**. There is no signature
 * anywhere that produces a message or email link to a person without the status
 * that governs them coming along.
 *
 * `telHref` is still exported from `format.ts`, because Team and Rep Detail call
 * *colleagues*, who have no lead status. `scripts/verify-dnc.mjs` holds the short
 * allowlist of files permitted to import it, so reaching for the raw builder on a
 * homeowner screen fails a gate rather than shipping.
 *
 * **What this deliberately does not decide.** Suppression is per-property, which
 * is where the flag lives today — while phone numbers live per-contact and a
 * household can have several. Whether Do Not Contact should attach to a person,
 * a number, or the address, whether it survives the same address being re-imported
 * in a later list, and whether a rep may reverse one are questions for counsel,
 * written up as question 2 in LEGAL.md. This closes the gap between what the app
 * records and what it does; it does not pre-empt the answer.
 */

/** Digits only — some Android dialers choke on formatting. */
function smsHref(phone?: string, body?: string): string | undefined {
  if (!phone) return undefined
  const digits = phone.replace(/[^\d+]/g, '')
  if (!digits) return undefined
  // iOS wants `&body=`, Android wants `?body=`. `?` works on both modern OSes.
  return body ? `sms:${digits}?body=${encodeURIComponent(body)}` : `sms:${digits}`
}

function mailHref(email?: string, subject?: string): string | undefined {
  if (!email) return undefined
  return subject ? `mailto:${email}?subject=${encodeURIComponent(subject)}` : `mailto:${email}`
}

/**
 * Statuses that withdraw contact, and the reason a rep is shown.
 *
 * A map rather than `status === 'dnc'` so that adding a second withdrawn state
 * is a line here instead of a search for every comparison. `won` and `lost` are
 * deliberately absent: they close a lead, they do not withdraw permission, and a
 * rep still has legitimate reasons to ring a customer who bought.
 */
const WITHDRAWN: Partial<Record<LeadStatus, string>> = {
  dnc: 'This household asked not to be contacted.',
}

export interface HomeownerContact {
  /** The person the links address, when there is one. */
  person?: Contact
  /** Undefined when there is no number, and undefined when contact is withdrawn. */
  tel?: string
  sms?: string
  mail?: string
  /**
   * Null when contact is allowed. Set when it is withdrawn — and then every link
   * above is undefined, so a caller that ignores this cannot accidentally render
   * a working button.
   */
  blocked: null | { reason: string }
}

export function homeownerContact(property: Property, contact?: Contact): HomeownerContact {
  const person = contact ?? property.contacts.find((c) => c.isPrimary) ?? property.contacts[0]
  const reason = WITHDRAWN[property.status]

  /*
    The links are not built at all when contact is withdrawn, rather than built
    and then hidden by the caller. A hidden href is one CSS mistake away from
    being tappable, and this has to fail closed.
  */
  if (reason) return { person, blocked: { reason } }

  return {
    person,
    tel: telHref(person?.phone),
    sms: smsHref(person?.phone, `Hi ${person?.name?.split(' ')[0] ?? ''}, `),
    mail: mailHref(person?.email, 'Following up on your property'),
    blocked: null,
  }
}
