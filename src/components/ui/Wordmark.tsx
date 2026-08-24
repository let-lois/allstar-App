/**
 * The wordmark, on its own light tile.
 *
 * The mark is fixed artwork: black "ALLSTAR", teal star, teal "HOME SOLUTIONS".
 * It is not interface, so it does not take the interface's colours — a brand
 * that changes colour with its surroundings is not a brand.
 *
 * On a near-black app that leaves one honest option, and it is the one every
 * brand guide reaches for: give the mark the light ground it was drawn for and
 * let *that* sit on the dark. The alternative — recolouring the type to white —
 * is what this replaces. It kept the mark legible and lost the thing the mark
 * is for.
 *
 * Centralised because the rule is easy to forget at the second call site, which
 * is exactly what happened: the console's rail kept the real artwork while the
 * ground went dark underneath it, and the wordmark spent a release as a black
 * shape on a black panel.
 */
export function Wordmark({
  width = 204,
  className = '',
}: {
  /** Rendered width in px. The tile sizes itself to the mark. */
  width?: number
  className?: string
}) {
  return (
    <div
      className={`inline-flex rounded-card bg-white px-4 py-3 shadow-card ${className}`}
      /* The artwork carries its own margins; this is the breathing room around
         them, scaled with the mark so a small rail lockup is not swamped. */
      style={{ padding: `${Math.round(width * 0.06)}px ${Math.round(width * 0.08)}px` }}
    >
      <img
        src="/logo.png"
        alt="Allstar Home Solutions"
        width={720}
        height={184}
        className="h-auto max-w-full"
        style={{ width }}
      />
    </div>
  )
}
