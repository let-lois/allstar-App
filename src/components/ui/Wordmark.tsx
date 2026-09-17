/*
  Imported rather than written as `/logo.png`.

  An absolute path is correct on the web and broken inside the native
  shell: a DOM component is loaded from a `file://` URL, so `/logo.png`
  resolves to the filesystem root and the mark renders as a broken-image
  placeholder — which is exactly what the first phone build showed. An
  import is a real dependency, so Vite emits it as a hashed asset and
  Metro bundles it into the webview's own assets. Expo's guidance says the
  same: prefer requiring an asset over the public directory.
*/
import logoUrl from '../../assets/logo.png'
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
  animate = false,
  className = '',
}: {
  /** Rendered width in px. The tile sizes itself to the mark. */
  width?: number
  /**
   * Arrive, and take one glint.
   *
   * Off by default and on only for the login, because the console's rail is
   * mounted for a whole session's worth of navigation — a mark that replays its
   * entrance every time someone opens a screen stops being a logo and becomes a
   * notification.
   */
  animate?: boolean
  className?: string
}) {
  return (
    <div
      className={`wordmark inline-flex rounded-card bg-white px-4 py-3 shadow-card ${
        animate ? 'wordmark-anim' : ''
      } ${className}`}
      /* The artwork carries its own margins; this is the breathing room around
         them, scaled with the mark so a small rail lockup is not swamped. */
      style={{ padding: `${Math.round(width * 0.06)}px ${Math.round(width * 0.08)}px` }}
    >
      <img
        src={logoUrl}
        alt="Allstar Home Solutions"
        width={720}
        height={184}
        className="h-auto max-w-full"
        style={{ width }}
      />
    </div>
  )
}
