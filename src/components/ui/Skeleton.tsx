/**
 * A placeholder shaped like the content that is on its way.
 *
 * Only for screens that actually fetch — the badge check, the audit log, the
 * console's settings panels. Everything a rep works from renders from the
 * phone's own copy and never waits, so it never shows one of these.
 *
 * The block holds the space the content will take, so nothing jumps when it
 * arrives. It pulses gently; under Reduce Motion the global rule in index.css
 * stops the pulse and it is a plain grey bar. The group carries the busy state
 * and one spoken line, so a screen reader hears "Loading the audit log" once
 * rather than a list of empty shapes.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`skeleton block rounded-md ${className}`} />
}

export function SkeletonRows({
  rows = 3,
  label,
  className = '',
  testId,
}: {
  rows?: number
  /** What is loading, read to a screen reader: "Loading the audit log". */
  label: string
  className?: string
  testId?: string
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={`space-y-3 ${className}`} data-testid={testId ?? 'skeleton'}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-3">
          <Skeleton className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={`h-3.5 ${i % 2 ? 'w-3/5' : 'w-4/5'}`} />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
