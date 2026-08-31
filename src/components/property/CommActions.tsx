import type { Contact, Property } from '../../types'
import { homeownerContact } from '../../lib/contact'

import { useAppStore } from '../../store/useAppStore'
import { haptic } from '../../lib/haptics'
import { Link } from 'react-router-dom'
import { IconMessage, IconNavigate, IconPhone } from '../nav/icons'

/**
 * Communication actions.
 *
 * These hand off to the device's own dialer, SMS app and maps app — a rep
 * should never be asked to copy a number into another app. Each hand-off is
 * logged locally so the activity timeline stays truthful even though the call
 * itself happens outside the app.
 *
 * Every link comes from `homeownerContact`, which takes the property and returns
 * nothing to call when the household has been marked Do Not Contact. This screen
 * used to build the links itself and never looked at the status, so a household
 * that asked not to be contacted still got three working buttons.
 */
export function CommActions({
  property,
  contact,
  compact,
}: {
  property: Property
  contact?: Contact
  compact?: boolean
}) {
  const logComm = useAppStore((s) => s.logComm)
  const { person: primary, tel, sms, mail, blocked } = homeownerContact(property, contact)

  const cls = compact
    ? 'min-h-[46px] flex-1 gap-1.5 text-[12.5px]'
    : 'min-h-[62px] flex-1 flex-col gap-1 text-[11.5px]'

  /*
    Said plainly rather than shown as three greyed-out buttons. A disabled
    control on this screen already means "no number on file", and a rep who
    reads it that way goes looking for the number somewhere else — which is the
    one outcome this is here to prevent. Navigate stays: Do Not Contact
    withdraws contact, it does not make the house disappear from a route the rep
    is already walking past.
  */
  if (blocked) {
    return (
      <div className="flex flex-col gap-2">
        <div
          data-testid="contact-blocked"
          className="bg-bad-bg text-bad border-bad/25 flex items-start gap-2 rounded-field border px-3 py-2.5 text-[12.5px] font-semibold"
        >
          <span aria-hidden="true" className="text-[15px] leading-none">⊘</span>
          <span>
            Do not contact.
            <span className="block font-normal opacity-90">{blocked.reason}</span>
          </span>
        </div>
        <Link
          to={`/navigate/${property.id}`}
          onClick={() => haptic('tap')}
          className={`metal metal-brand press focusable flex items-center justify-center rounded-field font-semibold ${cls}`}
        >
          <IconNavigate />
          Navigate
        </Link>
      </div>
    )
  }

  return (
    <div className="flex gap-2">
      <a
        href={tel}
        onClick={() => {
          if (!tel) return
          haptic('tap')
          logComm(property.id, 'call', primary?.name)
        }}
        aria-disabled={!tel}
        className={`metal metal-quiet press focusable flex items-center justify-center rounded-field font-semibold ${cls} ${
          tel ? 'text-ink-soft active:bg-surface-field' : 'pointer-events-none opacity-40'
        }`}
      >
        <IconPhone />
        Call
      </a>
      <a
        href={sms}
        onClick={() => {
          if (!sms) return
          haptic('tap')
          logComm(property.id, 'sms', primary?.name)
        }}
        aria-disabled={!sms}
        className={`metal metal-quiet press focusable flex items-center justify-center rounded-field font-semibold ${cls} ${
          sms ? 'text-ink-soft active:bg-surface-field' : 'pointer-events-none opacity-40'
        }`}
      >
        <IconMessage />
        Text
      </a>
      {!compact && (
        <a
          href={mail}
          onClick={() => {
            if (!mail) return
            logComm(property.id, 'email', primary?.name)
          }}
          aria-disabled={!mail}
          className={`metal metal-quiet press focusable flex items-center justify-center rounded-field font-semibold ${cls} ${
            mail ? 'text-ink-soft active:bg-surface-field' : 'pointer-events-none opacity-40'
          }`}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <rect x="3" y="5.5" width="18" height="13" rx="2" />
            <path d="M3.5 7l8.5 6 8.5-6" />
          </svg>
          Email
        </a>
      )}
      {/*
        Stays in the app rather than opening a tab. The visit gets logged here,
        and a rep who left to look at a map had to find their way back before
        anything was recorded. The Google Maps hand-off is still one tap away on
        that screen, for driving between neighbourhoods.
      */}
      <Link
        to={`/navigate/${property.id}`}
        onClick={() => haptic('tap')}
        className={`metal metal-brand press focusable flex items-center justify-center rounded-field font-semibold ${cls}`}
      >
        <IconNavigate />
        Navigate
      </Link>
    </div>
  )
}
