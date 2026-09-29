import { zipSync } from 'fflate'

/**
 * A tiny TIGER ADDRFEAT county file, written in the real format (a PolyLine
 * shapefile and its dBASE table, zipped), so the loader is tested against the
 * bytes it will read in production rather than against a parsed stand-in.
 *
 *   segments: [{ name, lf, lt, rf, rt, zl, zr, line: [[lng, lat], ...] }]
 */
export function addrfeatZip(fileBase, segments) {
  const shp = shapefileBytes(segments.map((s) => s.line))
  const dbf = dbfBytes(
    [['FULLNAME', 'C', 40], ['LFROMHN', 'C', 12], ['LTOHN', 'C', 12], ['RFROMHN', 'C', 12], ['RTOHN', 'C', 12], ['ZIPL', 'C', 5], ['ZIPR', 'C', 5]],
    segments.map((s) => [s.name, s.lf ?? '', s.lt ?? '', s.rf ?? '', s.rt ?? '', s.zl ?? '', s.zr ?? '']),
  )
  return zipSync({ [`${fileBase}.shp`]: shp, [`${fileBase}.dbf`]: dbf })
}

function shapefileBytes(lines) {
  const recs = lines.map((pts) => {
    const len = 4 + 32 + 4 + 4 + 4 + pts.length * 16
    const b = new DataView(new ArrayBuffer(8 + len))
    let o = 8
    b.setInt32(o, 3, true); o += 4
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    for (const v of [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]) { b.setFloat64(o, v, true); o += 8 }
    b.setInt32(o, 1, true); o += 4
    b.setInt32(o, pts.length, true); o += 4
    b.setInt32(o, 0, true); o += 4
    for (const [x, y] of pts) { b.setFloat64(o, x, true); o += 8; b.setFloat64(o, y, true); o += 8 }
    return b
  })
  const total = 100 + recs.reduce((a, r) => a + r.byteLength, 0)
  const out = new Uint8Array(total)
  const h = new DataView(out.buffer)
  h.setInt32(0, 9994, false)
  h.setInt32(24, total / 2, false)
  h.setInt32(28, 1000, true)
  h.setInt32(32, 3, true)
  const all = lines.flat()
  for (const [i, v] of [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))].entries()) h.setFloat64(36 + i * 8, v, true)
  let o = 100
  recs.forEach((r, i) => {
    r.setInt32(0, i + 1, false)
    r.setInt32(4, (r.byteLength - 8) / 2, false)
    out.set(new Uint8Array(r.buffer), o)
    o += r.byteLength
  })
  return out
}

function dbfBytes(fields, rows) {
  const recLen = 1 + fields.reduce((a, f) => a + f[2], 0)
  const headLen = 32 + fields.length * 32 + 1
  const out = new Uint8Array(headLen + rows.length * recLen + 1)
  const d = new DataView(out.buffer)
  out[0] = 0x03; out[1] = 126; out[2] = 9; out[3] = 29
  d.setUint32(4, rows.length, true)
  d.setUint16(8, headLen, true)
  d.setUint16(10, recLen, true)
  const enc = new TextEncoder()
  fields.forEach(([name, type, len], i) => {
    const at = 32 + i * 32
    out.set(enc.encode(name).slice(0, 10), at)
    out[at + 11] = type.charCodeAt(0)
    out[at + 16] = len
  })
  out[headLen - 1] = 0x0d
  rows.forEach((row, r) => {
    let at = headLen + r * recLen
    out[at++] = 0x20
    fields.forEach(([, , len], i) => {
      const bytes = enc.encode(String(row[i]).padEnd(len, ' ').slice(0, len))
      out.set(bytes, at)
      at += len
    })
  })
  out[out.length - 1] = 0x1a
  return out
}
