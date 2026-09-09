import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { LeadFields, useLeadDraft } from '../components/property/LeadForm'

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
 */
export function NewLead() {
  const nav = useNavigate()
  /*
    Straight into the new lead's profile. Somebody who came here to add one
    house is going to want to do something with it, and the back stack still
    holds wherever they came from.
  */
  const draft = useLeadDraft({ onSaved: (p) => nav(`/property/${p.id}`, { replace: true }) })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Add lead" back />

      <div className="scroll-pane bg-surface-sunk px-4 py-4">
        <div className="content-col">
          <Card>
            <LeadFields draft={draft} />
          </Card>
        </div>
      </div>

      {/*
        Pinned below the scrolling area, where it was before the form became
        shared. On a phone with the keyboard up there is room for about one
        field and this button, and the button is the half that must not scroll
        away.
      */}
      <div
        className="shrink-0 bg-surface px-4 pt-3.5 shadow-nav"
        style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
      >
        <Button size="lg" full onClick={() => void draft.save()} disabled={!draft.canSave}>
          {draft.saving ? 'Saving…' : 'Save lead'}
        </Button>
      </div>
    </div>
  )
}
