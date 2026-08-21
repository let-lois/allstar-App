/**
 * Initials, coloured from the name.
 *
 * Deterministic rather than random so the same person is the same colour on
 * every screen — that consistency is what makes an avatar scannable in a list
 * instead of decorative.
 *
 * The palette is one hue. It used to reach into blues and indigos, which in a
 * list of five people read as five unrelated products; four steps of the brand
 * teal read as one set of people. Each pairing is a light tint with its own
 * darker ink, all at 4.5:1 or better, because two capital letters at 11px is
 * small text and has to be legible rather than suggestive.
 */
const TINTS = [
  'bg-brand-50 text-brand-700',
  'bg-brand-100 text-brand-700',
  'bg-[#E3EDF0] text-[#0B5563]',
  'bg-surface-field text-ink-soft',
]

function tintFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return TINTS[h % TINTS.length]
}

export function Avatar({
  initials,
  name,
  size = 'md',
  className = '',
}: {
  initials: string
  /** Seeds the colour. Falls back to the initials when absent. */
  name?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const dim =
    size === 'sm'
      ? 'h-8 w-8 text-[11px]'
      : size === 'lg'
        ? 'h-12 w-12 text-[15px]'
        : 'h-10 w-10 text-[12px]'
  return (
    <span
      aria-hidden
      // Semibold, not bold: initials are a label for a row, not its headline.
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${dim} ${tintFor(name ?? initials)} ${className}`}
    >
      {initials}
    </span>
  )
}
