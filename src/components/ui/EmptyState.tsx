import type { ReactNode } from 'react'

/**
 * What an empty list says: what is empty, whether that is normal, and what to
 * do next. The action is optional and the caller decides it — a screen passes
 * one only when the person looking can do it, so a rep is never offered a
 * button the office owns.
 *
 * `compact` is for inside a lead's sections and cards, where a centred block
 * would be louder than the list it stands in for.
 */
export function EmptyState({
  title,
  body,
  action,
  compact = false,
  testId,
}: {
  title: string
  body?: ReactNode
  action?: ReactNode
  compact?: boolean
  testId?: string
}) {
  return (
    <div className={compact ? '' : 'px-6 py-8 text-center'} data-testid={testId ?? 'empty-state'}>
      <p className={compact ? 'text-[14.5px] font-medium text-ink-soft' : 'text-[15px] font-semibold text-ink-soft'}>{title}</p>
      {body && <p className={`mt-1 leading-snug text-ink-mute ${compact ? 'text-[13.5px]' : 'text-[14px]'}`}>{body}</p>}
      {action && <div className={compact ? 'mt-3' : 'mt-4 flex justify-center'}>{action}</div>}
    </div>
  )
}
