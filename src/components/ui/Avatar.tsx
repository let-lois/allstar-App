/**
 * Initials, coloured from the name.
 *
 * Deterministic rather than random so the same person is the same colour on
 * every screen — that consistency is what makes an avatar scannable in a list
 * instead of decorative.
 *
 * The palette is one hue. It used to reach into blues and indigos, which in a
 * list of five people read as five unrelated products; four steps of the brand
 * teal read as one set of people. Each pairing is a deep tint with its own
 * lighter ink, all well past 4.5:1, because two capital letters at 11px is small
 * text and has to be legible rather than suggestive.
 *
 * Inverted with the ground, and now literally so: each pairing is a token that
 * flips between a deep fill with light ink and a light fill with dark ink, so
 * the same rule holds in both themes. Held as hex here, they stayed dark when
 * the light theme arrived, and a dark circle with near-black initials on it is
 * two capitals nobody can read. See `.avatar-tint-1` in `index.css`.
 */
const TINTS = ['avatar-tint-1', 'avatar-tint-2', 'avatar-tint-3', 'avatar-tint-4']

function tintFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return TINTS[h % TINTS.length]
}

export function Avatar({
  initials,
  name,
  src,
  size = 'md',
  className = '',
}: {
  initials: string
  /** Seeds the colour. Falls back to the initials when absent. */
  name?: string
  /** A profile photo. Initials are the fallback, not the placeholder. */
  src?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const dim =
    size === 'sm'
      ? 'h-8 w-8 text-[11px]'
      : size === 'lg'
        ? 'h-12 w-12 text-[15px]'
        : 'h-10 w-10 text-[12px]'

  /*
    A photo when there is one, initials when there is not — and the initials are
    a real fallback rather than a spinner. Most of a roster will never upload a
    face, and a list of grey circles waiting for photos that are not coming is
    worse than the coloured initials this has always shown.

    `object-cover` because the source is already a centre-cropped square; this
    only guards against an avatar that arrived from somewhere else.
  */
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        className={`shrink-0 rounded-full object-cover ${dim} ${className}`}
      />
    )
  }

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
