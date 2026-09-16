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
      /*
        The *visible* viewport, not the layout one. iOS does not shrink the
        layout viewport for the software keyboard, so `inset-0` centres a
        dialog against a box that still believes it is full height — putting
        the buttons of any dialog with an input in it behind the keyboard.
        `--app-h` is already pinned to `visualViewport.height` for the app
        shell; this borrows the same measurement.
      */
      className="fixed inset-x-0 top-0 z-50 grid place-items-center bg-black/40 p-4"
      style={{ height: 'var(--app-h, 100dvh)' }}
      role={destructive ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      data-busy={busy ? 'true' : 'false'}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      {/*
        Capped at the viewport, with the question scrolling and the two buttons
        held out of it — the same shape `BottomSheet` uses, and for the same
        reason.

        Centred content that outgrows its container overflows in both
        directions, and a `fixed` parent has no scroll of its own to reach
        either end with. The bulk-delete question is a paragraph, a required
        input, a line of help and sometimes an error: on a phone that is taller
        than the screen before the keyboard opens, and every pixel of it was
        spent pushing Cancel and Confirm off the bottom, unreachable. A dialog
        whose confirm button cannot be reached is not a dialog.
      */}
      {/*
        The cap is written in the same units as the box around it rather than
        as `max-h-full`. A percentage max-height on a centred grid item does
        not reliably resolve against the padded area it sits in, and the panel
        was ending eleven pixels past the bottom of it — which a measurement
        caught and the eye would not have.
      */}
      <div
        ref={boxRef}
        className="flex w-full max-w-md flex-col rounded-card bg-surface shadow-float"
        style={{ maxHeight: 'calc(var(--app-h, 100dvh) - 2rem)' }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-6">
          <h2 id={`${testId}-title`} className="text-[19px] font-semibold leading-tight">
            {title}
          </h2>
          {children && <div className="mt-3 text-[15px] leading-relaxed text-ink-mute">{children}</div>}
        </div>
        <div className="flex shrink-0 flex-col-reverse gap-2 px-6 pb-6 pt-4 sm:flex-row sm:justify-end">
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
