import type { Contact, Property } from '../../types'
import { mailHref, smsHref, telHref } from '../../lib/format'

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
  const primary = contact ?? property.contacts.find((c) => c.isPrimary) ?? property.contacts[0]

  const tel = telHref(primary?.phone)
  const sms = smsHref(primary?.phone, `Hi ${primary?.name?.split(' ')[0] ?? ''}, `)
  const mail = mailHref(primary?.email, 'Following up on your property')

  const cls = compact
    ? 'min-h-[46px] flex-1 gap-1.5 text-[12.5px]'
    : 'min-h-[62px] flex-1 flex-col gap-1 text-[11.5px]'

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
        className={`press focusable flex items-center justify-center rounded-field ring-1 ring-ink/10 font-semibold ${cls} ${
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
        className={`press focusable flex items-center justify-center rounded-field ring-1 ring-ink/10 font-semibold ${cls} ${
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
          className={`press focusable flex items-center justify-center rounded-field ring-1 ring-ink/10 font-semibold ${cls} ${
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
        className={`press focusable flex items-center justify-center rounded-field bg-brand-50 font-semibold text-brand-600 ring-1 ring-brand-200 active:bg-brand-100 ${cls}`}
      >
        <IconNavigate />
        Navigate
      </Link>
    </div>
  )
}
