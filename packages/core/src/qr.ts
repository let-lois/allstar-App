import qrcode from 'qrcode-generator'

/**
 * A QR code as a grid of dark cells, and that grid as one SVG path.
 *
 * The encoder is `qrcode-generator` — no dependencies, MIT, and it runs
 * entirely on the phone: the badge is drawn offline and nothing about who is
 * looking at it leaves the device. Its own SVG output is a string for
 * `innerHTML`; drawing from the module grid instead keeps the markup React's
 * and lets the path scale with the badge rather than the cell size.
 *
 * Error correction M (~15%) is the usual choice for a code that is printed
 * small and scanned from a handshake away. Type 0 lets the encoder pick the
 * smallest version that fits, so a short URL stays a coarse, easy grid.
 */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}

/** One `d` attribute for every dark cell, in a viewBox of `n` by `n` units. */
export function qrPath(modules: boolean[][]): string {
  const parts: string[] = []
  modules.forEach((row, r) => {
    let c = 0
    while (c < row.length) {
      if (!row[c]) {
        c += 1
        continue
      }
      // Runs of dark cells become one rectangle: fewer path commands, and no
      // hairline seams between neighbours when the renderer anti-aliases.
      let end = c
      while (end < row.length && row[end]) end += 1
      parts.push(`M${c} ${r}h${end - c}v1h-${end - c}z`)
      c = end
    }
  })
  return parts.join('')
}
