/**
 * Initials, coloured from the name.
 *
 * Deterministic rather than random so the same person is the same colour on
 * every screen — that consistency is what makes an avatar scannable in a list
 * instead of decorative. The palette is warm and desaturated so a row of them
 * reads as one family and never competes with the orange accent.
 *
 * The raised edge comes from `.emboss`, which is background-agnostic and so
 * composes over every tint here without needing a variant per colour.
 */
const TINTS = [
  'bg-brand-100 text-brand-700',
  'bg-[#E8F0FB] text-[#1E4E8C]',
  'bg-[#EAF5EC] text-[#1F6B3A]',
  'bg-[#F3ECFB] text-[#5B3A9B]',
  'bg-[#FDEEE6] text-[#9A3412]',
  'bg-[#E9F4F5] text-[#15616D]',
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
    size === 'sm' ? 'h-8 w-8 text-[11px]' : size === 'lg' ? 'h-12 w-12 text-sm' : 'h-10 w-10 text-xs'
  return (
    <span
      aria-hidden
      className={`emboss grid shrink-0 place-items-center rounded-full font-bold ${dim} ${tintFor(name ?? initials)} ${className}`}
    >
      {initials}
    </span>
  )
}
