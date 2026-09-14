import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'

/**
 * A modal that asks before something irreversible happens.
 *
 * The one job of this component is to make a destructive action take two
 * deliberate taps instead of one. So the confirm button is never the default
 * focus — focus lands on Cancel, and Enter from there closes without doing
 * anything. Escape and a tap on the backdrop do the same. Nothing here can be
 * triggered by the key that was pressed a moment ago on the screen behind it.
 *
 * While the action runs the confirm button reads as busy and both buttons are
 * disabled, so a second tap during a slow request cannot start a second
 * request. The caller owns the copy — this component knows nothing about
 * leads, only about asking.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  busy = false,
  onConfirm,
  onCancel,
  destructive = false,
  confirmDisabled = false,
  testId = 'confirm-dialog',
}: {
  title: string
  children?: ReactNode
  confirmLabel: string
  busyLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  destructive?: boolean
  confirmDisabled?: boolean
  testId?: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Cancel takes focus, never Confirm: Enter must not be the second tap.
    boxRef.current?.querySelector<HTMLButtonElement>('[data-testid$="-cancel"]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role={destructive ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      data-busy={busy ? 'true' : 'false'}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div ref={boxRef} className="w-full max-w-md rounded-card bg-surface p-6 shadow-float">
        <h2 id={`${testId}-title`} className="text-[19px] font-semibold leading-tight">
          {title}
        </h2>
        {children && <div className="mt-3 text-[15px] leading-relaxed text-ink-mute">{children}</div>}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" disabled={busy} onClick={onCancel} data-testid={`${testId}-cancel`}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
            data-testid={`${testId}-confirm`}
          >
            {busy ? busyLabel ?? confirmLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
