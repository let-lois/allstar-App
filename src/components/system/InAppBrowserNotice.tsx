import { IconWarn } from '../nav/icons'
import { useState } from 'react'
import {
  copyCurrentUrl,
  detectInAppBrowser,
  openInChromeAndroid,
} from '../../lib/webview'

const DISMISS_KEY = 'allstar.inAppNoticeDismissed'

/**
 * Warns a rep who opened the app from inside a messaging app's browser.
 *
 * Deliberately not a hard block: everything except camera, mic and location
 * still works here, and a rep who just wants to check their route shouldn't be
 * stopped. But it has to be said *before* they try to take a photo and conclude
 * the product is broken — that's the failure this prevents.
 *
 * Dismissal is per-session, not permanent: the rep is likely to reopen from the
 * same thread tomorrow and needs telling again.
 */
export function InAppBrowserNotice({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  const [info] = useState(detectInAppBrowser)
  /*
    Read in a try, like the write below it already was.

    `sessionStorage` is not merely empty where site data is blocked — a private
    window, a locked-down WebView, some enterprise profiles — the accessor
    itself throws. This component mounts in the app shell, so an exception here
    is not a missing banner, it is a white screen for the whole app.
  */
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })
  const [copied, setCopied] = useState(false)

  if (!info.isInApp || dismissed) return null

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* private mode — dismiss for this render only */
    }
    setDismissed(true)
  }

  const where = info.app ? `${info.app}’s browser` : 'an in-app browser'

  return (
    <div
      role="alert"
      className={`shrink-0 px-3 py-2.5 text-xs ${
        tone === 'dark' ? 'bg-warn/15 text-[#FDE68A]' : 'bg-warn-bg text-warn'
      }`}
    >
      <div className="mx-auto flex max-w-[600px] items-start gap-2.5">
        <span aria-hidden className="icon-sm mt-0.5 grid shrink-0 place-items-center">
          <IconWarn />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug">
            You’re in {where}. Camera, microphone and location won’t work here.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {info.platform === 'android' ? (
              <button
                onClick={openInChromeAndroid}
                className={`focusable min-h-tap rounded-field px-3.5 font-semibold ${
                  tone === 'dark'
                    ? 'bg-warn-bg text-warn'
                    : 'bg-warn text-surface-sunk'
                }`}
              >
                Open in Chrome
              </button>
            ) : (
              <button
                onClick={async () => setCopied(await copyCurrentUrl())}
                className={`focusable min-h-tap rounded-field px-3.5 font-semibold ${
                  tone === 'dark'
                    ? 'bg-warn-bg text-warn'
                    : 'bg-warn text-surface-sunk'
                }`}
              >
                {copied ? 'Link copied — paste in Safari' : 'Copy link'}
              </button>
            )}
            <button
              onClick={dismiss}
              className="focusable min-h-tap rounded-field px-3 font-semibold underline-offset-2 hover:underline"
            >
              Continue anyway
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
