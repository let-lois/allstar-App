import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { LeadFields, useLeadDraft } from '../components/property/LeadForm'
import { clearLeadDraft, isBlankDraft, loadLeadDraft, saveLeadDraft } from '../lib/lead-draft'
import { relative } from '../lib/format'
import { useAppStore } from '../store/useAppStore'

/**
 * Add a lead, from anywhere that isn't the map.
 *
 * The form itself moved to `LeadForm` when the map learned to open the same one
 * over a tapped house — see the note there for how the pin gets set and why a
 * typed address saves without a city. What is left here is the difference: a
 * screen of its own, reached from the quick actions or an empty list, with no
 * pin already chosen and nowhere to go afterwards except the lead just made.
 *
 * Kept as a route rather than folded into the map on purpose. It is the entry
 * point for someone in the office with a phone number on a sticky note, and for
 * a rep whose map cannot draw — neither of whom has a house to tap.
 *
 * ## Save for later
 *
 * This screen, and not the map's sheet, is where a form gets put aside. The
 * sheet is opened over a house the rep is looking at, and its draft belongs to
 * that tap; here the rep arrived on purpose with something to type and may be
 * interrupted before it is a lead. What they typed is kept on the phone (see
 * `lib/lead-draft.ts`) and offered back the next time this screen opens —
 * after leaving it, and after the app has been killed — without ever becoming
 * a lead: no pin, no row, nothing queued for the office, until they press
 * Save lead.
 */
export function NewLead() {
  const nav = useNavigate()
  const userId = useAppStore((s) => s.user?.id) ?? 'anonymous'
  /*
    Straight into the new lead's profile. Somebody who came here to add one
    house is going to want to do something with it, and the back stack still
    holds wherever they came from.

    The draft goes first: a lead that exists is not also something to come
    back to.
  */
  const draft = useLeadDraft({
    onSaved: (p) => {
      void clearLeadDraft(userId)
      nav(`/property/${p.id}`, { replace: true })
    },
  })

  /*
    Restore, once, on arrival. The setters are the form's own, so a restored
    draft is indistinguishable from typing — including `markTouched`, which
    stops a later address lookup from overwriting what the rep had written.
    Restoring is not the same as the rep asking for it, so the screen says
    when the draft is from and offers to throw it away.
  */
  const [restoredAt, setRestoredAt] = useState<number | null>(null)
  const [putAside, setPutAside] = useState(false)
  const restore = useRef(draft)
  restore.current = draft
  useEffect(() => {
    let alive = true
    void loadLeadDraft(userId).then((d) => {
      if (!alive || !d || isBlankDraft(d)) return
      const form = restore.current
      form.markTouched()
      form.setAddress(d.address)
      form.setPicked(d.picked)
      form.setName(d.name)
      form.setPhone(d.phone)
      for (const id of d.listIds) form.toggleList(id)
      form.setNewListName(d.newListName)
      setRestoredAt(d.savedAt)
    })
    return () => {
      alive = false
    }
    // On mount only: the draft is read for the person who opened the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const snapshot = () => ({
    address: draft.address,
    picked: draft.picked,
    name: draft.name,
    phone: draft.phone,
    listIds: draft.listIds,
    newListName: draft.newListName,
  })
  const blank = isBlankDraft(snapshot())

  async function saveForLater() {
    if (blank || draft.saving) return
    await saveLeadDraft(userId, snapshot())
    setPutAside(true)
    // Put aside means leaving. The back stack holds wherever they came from,
    // and the draft is here when they return.
    nav(-1)
  }

  async function discard() {
    await clearLeadDraft(userId)
    draft.setAddress('')
    draft.setPicked(null)
    draft.setName('')
    draft.setPhone('')
    for (const id of draft.listIds) draft.toggleList(id)
    draft.setNewListName('')
    setRestoredAt(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Add lead" back />

      <div className="scroll-pane bg-surface-sunk px-4 py-4">
        <div className="content-col">
          {restoredAt !== null && (
            <div
              className="mb-3 flex items-center justify-between gap-3 rounded-field bg-surface-tint px-3 py-2.5 text-[13px] text-ink"
              role="status"
              data-testid="lead-draft-restored"
            >
              <span>
                Picking up where you left off — saved {relative(restoredAt)}. Nothing is a lead yet.
              </span>
              <button
                type="button"
                onClick={() => void discard()}
                className="focusable shrink-0 font-semibold text-accent"
                data-testid="lead-draft-discard"
              >
                Discard
              </button>
            </div>
          )}
          <Card>
            <LeadFields draft={draft} />
          </Card>
        </div>
      </div>

      {/*
        Pinned below the scrolling area, where it was before the form became
        shared. On a phone with the keyboard up there is room for about one
        field and this button, and the button is the half that must not scroll
        away. Save for later sits under it, quieter: it is the exception, not
        the way out.
      */}
      <div
        className="shrink-0 bg-surface px-4 pt-3.5 shadow-nav"
        style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
      >
        <Button size="lg" full onClick={() => void draft.save()} disabled={!draft.canSave}>
          {draft.saving ? 'Saving…' : 'Save lead'}
        </Button>
        <Button
          variant="secondary"
          full
          className="mt-2"
          onClick={() => void saveForLater()}
          disabled={blank || draft.saving || putAside}
          data-testid="lead-save-later"
        >
          {putAside ? 'Saved for later' : 'Save for later'}
        </Button>
      </div>
    </div>
  )
}
