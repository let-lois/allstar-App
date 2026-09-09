/**
 * The pin that says "here, this spot" — one shape, both maps.
 *
 * A lead on this map is a round coloured dot; its colour is its status. The
 * place a rep has just *tapped* is not a lead yet and has no status, so making
 * it another dot would be the one mistake that matters here — the rep would be
 * looking for their own tap among the houses they already have. It is a
 * teardrop instead: the shape everyone already reads as "this location", from
 * every map application they have ever used, and the only teardrop on this map.
 *
 * White body, dark rim, dark centre. That combination survives both grounds this
 * app draws on — bright satellite imagery and the dark basemap — where a single
 * hue would disappear into one of them. It also borrows no status colour, which
 * is what keeps "somewhere I tapped" from reading as "a lead of some kind".
 *
 * Defined once and shared because the two renderers cannot be allowed to drift
 * on this: `SELECTED_PIN` is already a different teal in each of them, which is
 * exactly the sort of small divergence that makes a rep's map look like two
 * different products depending on whether Google loaded.
 */

/** Material's "place" glyph. Tip at (12, 23) in a 24-unit box — see `TIP_Y`. */
export const LOCATION_PIN_PATH =
  'M12 1.6c-4.2 0-7.6 3.4-7.6 7.6 0 5.7 7.6 13.8 7.6 13.8s7.6-8.1 7.6-13.8c0-4.2-3.4-7.6-7.6-7.6z'

/** The box the path is drawn in, and where its point lands inside it. */
export const PIN_BOX = 24
export const TIP_X = 12
export const TIP_Y = 23

const BODY = '#FFFFFF'
const RIM = '#111827'

/**
 * The pin as SVG nodes, for the self-rendered map.
 *
 * Takes the screen point its *tip* should land on, not its centre: a map pin
 * means the place under its point, and getting that wrong by half a pin height
 * is a whole house at the zoom a rep works at.
 */
export function LocationPinSvg({
  x,
  y,
  height = 40,
  label = 'Selected location',
}: {
  x: number
  y: number
  height?: number
  label?: string
}) {
  const s = height / PIN_BOX
  return (
    <g
      transform={`translate(${x - TIP_X * s} ${y - TIP_Y * s}) scale(${s})`}
      data-testid="location-pin"
      role="img"
      aria-label={label}
      style={{ pointerEvents: 'none' }}
    >
      {/*
        Drawn twice: a dark halo under the shape, then the shape. A drop shadow
        would be the obvious way and is not available here — this is inline SVG
        inside a map that is already compositing tiles, and a filter on it costs
        a paint on every pan. A fattened copy of the same path costs nothing.
      */}
      <path d={LOCATION_PIN_PATH} fill="rgba(17,24,39,.35)" stroke="rgba(17,24,39,.35)" strokeWidth={3} />
      <path d={LOCATION_PIN_PATH} fill={BODY} stroke={RIM} strokeWidth={1.6} />
      <circle cx={TIP_X} cy={9.2} r={3} fill={RIM} />
    </g>
  )
}

/**
 * The same pin as DOM, for Google's advanced markers.
 *
 * Built as nodes rather than assigned as markup, matching the other marker
 * builders in `GoogleFieldMap` — nothing here is user data, but `innerHTML` on
 * a marker-building path is a habit worth not having.
 *
 * Google anchors an advanced marker's content by its bottom centre, which is
 * where this shape's tip sits, so no offset is needed.
 */
export function locationPinElement(height = 44): HTMLElement {
  const el = document.createElement('div')
  el.dataset.testid = 'location-pin'
  el.style.cssText = [
    `width:${Math.round((height / PIN_BOX) * PIN_BOX)}px`,
    `height:${height}px`,
    'display:block',
    // The tip is the point. Without this the marker sits half a pin too low,
    // because the shape's ink stops short of its own box at the bottom.
    `transform:translateY(${((PIN_BOX - TIP_Y) / PIN_BOX) * height}px)`,
    'pointer-events:none',
  ].join(';')

  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${PIN_BOX} ${PIN_BOX}`)
  svg.setAttribute('width', String(height))
  svg.setAttribute('height', String(height))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Selected location')

  const halo = document.createElementNS(ns, 'path')
  halo.setAttribute('d', LOCATION_PIN_PATH)
  halo.setAttribute('fill', 'rgba(17,24,39,.35)')
  halo.setAttribute('stroke', 'rgba(17,24,39,.35)')
  halo.setAttribute('stroke-width', '3')

  const body = document.createElementNS(ns, 'path')
  body.setAttribute('d', LOCATION_PIN_PATH)
  body.setAttribute('fill', BODY)
  body.setAttribute('stroke', RIM)
  body.setAttribute('stroke-width', '1.6')

  const dot = document.createElementNS(ns, 'circle')
  dot.setAttribute('cx', String(TIP_X))
  dot.setAttribute('cy', '9.2')
  dot.setAttribute('r', '3')
  dot.setAttribute('fill', RIM)

  svg.append(halo, body, dot)
  el.appendChild(svg)
  return el
}
