import type { PickedAddress } from '../components/property/AddressAutocomplete'
import { metaGet, metaSet } from './db'

/**
 * A lead that is not finished yet, kept on the phone until it is.
 *
 * The add-lead form used to be all or nothing: everything typed lived in
 * component state, so the rep who got as far as the homeowner's name and then
 * had to answer the door — or the phone, or a manager — came back to an empty
 * form and typed it again, or more often did not. "Save for later" keeps what
 * was typed without making it a lead: nothing goes into `properties`, nothing
 * is queued for the office, and the map shows no pin, because a half-filled
 * form is not a house anyone has spoken to.
 *
 * ## Where it lives, and what that means
 *
 * On this device, in the same IndexedDB the leads themselves use, under the
 * signed-in person's id. That gives it the two properties the feature needs —
 * it survives leaving the screen and it survives the app being killed — and
 * one it does not have, which is worth saying plainly: it does not follow the
 * person to another phone, and signing out wipes cached data on this one
 * (`wipeCachedData`), the draft included. A draft is a note to yourself, not a
 * record, and a note that outlived the account it was written under would be
 * somebody else's problem to find.
 *
 * One draft per person. A second "save for later" replaces the first, which
 * is the behaviour a rep expects from a single form: there is one thing they
 * were in the middle of.
 */
export interface LeadDraftRecord {
  address: string
  picked: PickedAddress | null
  name: string
  phone: string
  listIds: string[]
  newListName: string
  /** When it was put aside, so the form can say so. */
  savedAt: number
}

const key = (userId: string) => `allstar.leaddraft.${userId}`

/** True when nothing worth keeping has been typed. */
export function isBlankDraft(d: Omit<LeadDraftRecord, 'savedAt'>): boolean {
  return (
    !d.address.trim() && !d.picked && !d.name.trim() && !d.phone.trim() && d.listIds.length === 0 && !d.newListName.trim()
  )
}

export async function loadLeadDraft(userId: string): Promise<LeadDraftRecord | null> {
  try {
    const d = await metaGet<LeadDraftRecord | null>(key(userId))
    // Defensive on the shape: a draft written by an older build is not worth
    // a crash on the add-lead screen.
    if (!d || typeof d !== 'object' || typeof d.address !== 'string') return null
    return {
      address: d.address,
      picked: d.picked && typeof d.picked === 'object' ? d.picked : null,
      name: typeof d.name === 'string' ? d.name : '',
      phone: typeof d.phone === 'string' ? d.phone : '',
      listIds: Array.isArray(d.listIds) ? d.listIds.filter((x): x is string => typeof x === 'string') : [],
      newListName: typeof d.newListName === 'string' ? d.newListName : '',
      savedAt: typeof d.savedAt === 'number' ? d.savedAt : Date.now(),
    }
  } catch {
    return null
  }
}

export async function saveLeadDraft(userId: string, d: Omit<LeadDraftRecord, 'savedAt'>): Promise<void> {
  await metaSet(key(userId), { ...d, savedAt: Date.now() } satisfies LeadDraftRecord)
}

/** Written as null rather than deleted: `metaSet` is the only write the meta store has. */
export async function clearLeadDraft(userId: string): Promise<void> {
  await metaSet(key(userId), null)
}
