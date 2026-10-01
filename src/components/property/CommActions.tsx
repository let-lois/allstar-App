import type { Contact, Property } from '../../types'
import { homeownerContact } from '../../lib/contact'

import { useAppStore } from '../../store/useAppStore'
import { haptic } from '../../lib/haptics'
import { Link } from 'react-router-dom'
import { IconMessage, IconNavigate, IconPhone } from '../nav/icons'
import { useEffect, useRef, useState } from 'react'
import { COULD_NOT_OPEN, openExternal, shellOpener } from '../../lib/external'

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
  // One line under the buttons, gone after a few seconds.
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const say = (text: string) => {
    setMessage(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMessage(null), 4000)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])

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
    <div className="flex flex-col gap-2">
    <div className="flex gap-2">
      <ContactAction
        href={tel}
        label="Call"
        missing="No phone number available for this lead."
        cls={cls}
        onMessage={say}
        onOpened={() => {
          haptic('tap')
          logComm(property.id, 'call', primary?.name)
        }}
      >
        <IconPhone />
      </ContactAction>
      <ContactAction
        href={sms}
        label="Text"
        missing="No phone number available for this lead."
        cls={cls}
        onMessage={say}
        onOpened={() => {
          haptic('tap')
          logComm(property.id, 'sms', primary?.name)
        }}
      >
        <IconMessage />
      </ContactAction>
      {!compact && (
        <ContactAction
          href={mail}
          label="Email"
          missing="No email address available for this lead."
          cls={cls}
          onMessage={say}
          onOpened={() => logComm(property.id, 'email', primary?.name)}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
            <rect x="3" y="5.5" width="18" height="13" rx="2" />
            <path d="M3.5 7l8.5 6 8.5-6" />
          </svg>
        </ContactAction>
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
      {/* Said, not implied: a greyed button reads as "broken", not "no number". */}
      {message && (
        <p role="status" data-testid="comm-message" className="rounded-field bg-surface-field px-3 py-2 text-[13px] font-medium text-ink-soft">
          {message}
        </p>
      )}
    </div>
  )
}

/**
 * One of Call, Text and Email.
 *
 * With something to open, a link — so a browser follows it, and a long press
 * offers what a phone offers for a number. Inside the phone app the tap goes
 * through the shell's own hand-off instead (see `lib/external.ts`), which says
 * whether the phone could open it; the call is only logged once it did.
 *
 * With nothing to open, still a button: tapping it says why rather than
 * leaving a rep poking at a control that does nothing.
 *
 * Every tap stops here, so a row or a sheet this sits in never takes it too.
 */
function ContactAction({
  href,
  label,
  missing,
  cls,
  onOpened,
  onMessage,
  children,
}: {
  href?: string
  label: string
  missing: string
  cls: string
  onOpened: () => void
  onMessage: (text: string) => void
  children: React.ReactNode
}) {
  const base = `metal metal-quiet press focusable flex items-center justify-center rounded-field font-semibold ${cls}`
  if (!href) {
    return (
      <button
        type="button"
        // Operable — it explains itself — so not aria-disabled, which would
        // tell a screen reader there is nothing here to press.
        aria-label={`${label}: ${missing}`}
        data-state="missing"
        data-testid={`comm-${label.toLowerCase()}`}
        onClick={(e) => {
          e.stopPropagation()
          onMessage(missing)
        }}
        className={`${base} text-ink-mute opacity-60`}
      >
        {children}
        {label}
      </button>
    )
  }
  return (
    <a
      href={href}
      data-testid={`comm-${label.toLowerCase()}`}
      onClick={(e) => {
        e.stopPropagation()
        if (!shellOpener()) {
          // A browser follows the href itself.
          onOpened()
          return
        }
        e.preventDefault()
        void openExternal(href).then((opened) => {
          if (opened) onOpened()
          else onMessage(COULD_NOT_OPEN)
        })
      }}
      className={`${base} text-ink-soft active:bg-surface-field`}
    >
      {children}
      {label}
    </a>
  )
}
