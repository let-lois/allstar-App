import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BottomSheet } from '../ui/BottomSheet'
import { haptic } from '../../lib/haptics'
import {
  IconCalendar,
  IconCamera,
  IconNote,
  IconPlus,
  IconRoute,
  IconUpload,
} from './icons'
import { useAppStore } from '../../store/useAppStore'

/**
 * Floating quick-action button.
 *
 * Sits above the bottom nav on the right — reachable by thumb, out of the way
 * of list content. Opens a sheet of full-width targets rather than a radial
 * menu, because reps hit this while moving.
 */
export function QuickActions() {
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const { pathname } = useLocation()
  const route = useAppStore((s) => s.route)
  const role = useAppStore((s) => s.user?.role)
  const isRep = role === 'field_rep'

  const activeStop = route?.stops.find((s) => s.status === 'active')

  /*
    Screens that pin their own primary action to the bottom don't get a floating
    one on top of it. At 320px the button was landing squarely on "Start visit" —
    a second orange circle covering the one control the whole screen exists to
    offer. A quick-action shortcut is never worth obscuring the action itself.
  */
  if (/^\/(property|lead|schedule|visit|capture)/.test(pathname)) return null

  /*
    The list is chosen by job.

    This button used to be rep-only, which left the office with no way to add
    anything from anywhere — and the office adds plenty. But handing them the
    rep's five is not the fix either: "Start next visit" offers a manager a route
    they do not have, and a shortcut whose subtitle is "Pick a property first" is
    a dead end wearing an action's clothes.

    So a rep gets the doorstep five, and the office gets the three things it
    actually does from a phone: put a lead in, book something, and bring a list
    of leads in from a file.
  */
  const repActions = [
    {
      label: 'Start next visit',
      hint: activeStop ? 'Next stop on your route' : 'Pick a property first',
      icon: <IconRoute />,
      run: () => (activeStop ? nav(`/property/${activeStop.propertyId}?start=1`) : nav('/map')),
    },
    {
      label: 'Add lead',
      hint: 'Drop a new property at your location',
      icon: <IconPlus />,
      run: () => nav('/lead/new'),
    },
    {
      label: 'Take photo',
      hint: 'Attach to a property',
      icon: <IconCamera />,
      run: () =>
        activeStop ? nav(`/property/${activeStop.propertyId}?capture=1`) : nav('/leads'),
    },
    {
      label: 'Add note',
      hint: 'Quick note or dictation',
      icon: <IconNote />,
      run: () => (activeStop ? nav(`/property/${activeStop.propertyId}?note=1`) : nav('/leads')),
    },
    {
      label: 'Schedule',
      hint: 'Appointment or follow-up',
      icon: <IconCalendar />,
      run: () => nav('/schedule/new'),
    },
  ]

  const officeActions = [
    {
      label: 'Add lead',
      hint: 'One property, entered by hand',
      icon: <IconPlus />,
      run: () => nav('/lead/new'),
    },
    {
      label: 'Import leads',
      hint: 'Upload a CSV from a list provider',
      icon: <IconUpload />,
      run: () => nav('/admin/import'),
    },
    {
      label: 'Schedule',
      hint: 'Appointment or follow-up',
      icon: <IconCalendar />,
      run: () => nav('/schedule/new'),
    },
  ]

  const actions: { label: string; hint: string; icon: JSX.Element; run: () => void }[] = isRep
    ? repActions
    : officeActions

  return (
    <>
      <button
        onClick={() => {
          haptic('tap')
          setOpen(true)
        }}
        aria-label="Quick actions"
        data-tour="quick-actions"
        className="metal metal-brand press focusable fixed right-4 z-30 grid h-14 w-14 place-items-center rounded-full md:hidden"
        style={{ bottom: 'calc(76px + env(safe-area-inset-bottom, 0px))' }}
      >
        <IconPlus />
      </button>

      <BottomSheet open={open} onClose={() => setOpen(false)} title="Quick actions" detents={[0.6]}>
        <ul className="space-y-2 pt-1">
          {actions.map((a) => (
            <li key={a.label}>
              <button
                onClick={() => {
                  setOpen(false)
                  a.run()
                }}
                className="metal metal-quiet press focusable flex min-h-[64px] w-full items-center gap-3 rounded-card px-4 text-left"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-field bg-surface-tint text-accent">
                  {a.icon}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">{a.label}</span>
                  <span className="block truncate text-xs text-ink-mute">{a.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>
    </>
  )
}
