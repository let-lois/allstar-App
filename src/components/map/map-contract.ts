/**
 * The decisions both map renderers must make the same way.
 *
 * `FieldMap` and `GoogleFieldMap` are not two implementations of one map — they
 * are two maps behind one prop contract, and which one a rep gets is an
 * environment fact (is Google configured, did it draw) rather than anything a
 * screen chooses. That only works while they *behave* the same, and behaviour
 * is where they drift: one is SVG over arithmetic this repo owns, the other is
 * a library whose events arrive in a different shape.
 *
 * So the parts where drift is both likely and invisible live here as plain
 * data and plain functions, imported by both. Two properties follow:
 *
 *   - A change is made once. Adding a tap mode to one renderer and forgetting
 *     the other is the failure this file exists to make impossible.
 *   - It is testable without a browser and without a Google key, which nothing
 *     about `GoogleFieldMap` otherwise is. `verify:mapparity` runs the truth
 *     table below and checks both renderers import it rather than reimplement
 *     it. Same argument as `packages/core/src/basemap.ts`, which exists for
 *     exactly this reason.
 */

/**
 * How far out either map can go.
 *
 * 1, not 12 and not 0. It was 12 — a neighbourhood — while the only thing these
 * maps showed was a territory, and that was wrong the moment a screen had to
 * show a rep in one country and a door in another: the two are thousands of
 * kilometres off opposite edges, the line between them cannot be drawn, and the
 * far-away case had to be handed to whichever renderer could zoom out. Two
 * renderers that disagree about what they can show is precisely what the shared
 * contract exists to prevent, so the number is here rather than in either file.
 *
 * Not 0, which is the whole world in 256 pixels: a map nobody can aim at, and
 * one zoom level below a view that already holds any two points on Earth.
 */
export const MAP_MIN_ZOOM = 1

/**
 * How far in each map can go — and they differ, on purpose.
 *
 * `FieldMap`'s ceiling is its tile provider's: MapTiler's streets stop at 20
 * and its satellite at 19, and past that the tiles are upscaled. That is a fact
 * about a vendor, not a product decision, so it must not become Google's
 * ceiling too. Google has genuine imagery past 19 in most built-up areas, and
 * capping it at 19 for symmetry would throw away the one thing a rep zooms in
 * for: telling one driveway from the next.
 *
 * What the contract requires is that Google is never *worse*, which is the
 * assertion the gate makes. A rep who loses the Google map mid-morning gets a
 * shallower map; a rep who gains it never gets a shallower one.
 */
export const FIELDMAP_MAX_ZOOM = 19
export const GOOGLE_MAX_ZOOM = 21

/** The shape being drawn, as both renderers style it. */
export const DRAW_STROKE = '#20C4D3'
/**
 * The fill, as a colour and an opacity rather than one `rgba()` string.
 *
 * It was `rgba(15,169,184,0.16)`, which SVG reads correctly and Google does
 * not reliably: `fillColor` and `fillOpacity` are separate options on a
 * `google.maps.Polygon`, and a colour carrying its own alpha is at best
 * redundant and at worst ignored — leaving `fillOpacity: 1` in charge and
 * painting a solid teal slab over the map somebody is drawing on.
 *
 * Two values, so each renderer applies them the way its own primitive expects
 * and neither has to know what the other's colour parser does with a fourth
 * channel. SVG has `fill` and `fill-opacity` too, so nothing is lost.
 */
export const DRAW_FILL = '#0FA9B8'
export const DRAW_FILL_OPACITY = 0.16
export const DRAW_STROKE_WIDTH = 2.5
/** White with a teal ring, matching the self-rendered map's vertex handles. */
export const DRAW_VERTEX_FILL = '#ffffff'
export const DRAW_VERTEX_RADIUS = 6

/**
 * A drawn shape closes itself at three points, and not before.
 *
 * Under three it is a line and is drawn dashed and unfilled, which is what
 * tells somebody they need one more tap. This is the rule, not a rendering
 * detail: the two renderers express it with completely different primitives
 * (an SVG `Z` and a `google.maps.Polygon` vs `Polyline`) and would otherwise
 * each have their own opinion about when a shape becomes a shape.
 */
export const DRAW_CLOSES_AT = 3

export function drawClosed(points: readonly unknown[]): boolean {
  return points.length >= DRAW_CLOSES_AT
}

/**
 * The overlay the Google renderer should be showing for a part-drawn shape.
 *
 * A pure function returning plain data, and that is the whole reason it exists.
 * Constructing `google.maps.Polygon` needs the Maps API, which needs a real key
 * on an allowed origin, which is a key committed somewhere — so the riskiest
 * lines in `GoogleFieldMap` were the ones nothing could execute. Moving the
 * *decision* out leaves that file with one job, applying it, and lets a Node
 * gate assert the exact options for every point count.
 *
 * Three things here are load-bearing rather than cosmetic, and each cost
 * something to learn:
 *
 *   **`clickable: false`.** A Google overlay swallows the click that lands on
 *   it, and this shape covers precisely the part of the map somebody is still
 *   drawing on. Without it the third tap inside a triangle hits the polygon,
 *   the map's own listener never fires, and the vertex is silently lost. The
 *   self-rendered map cannot have this bug — its shape is an SVG under the
 *   pointer handler — so it is a Google-only trap.
 *
 *   **`fillOpacity` separate from `fillColor`.** They are separate options, and
 *   a colour carrying its own alpha has it ignored — leaving `fillOpacity` in
 *   charge. Get that wrong with `fillOpacity: 1` and the map is a solid teal
 *   slab.
 *
 *   **The dashes are a repeating symbol.** Maps JS has no dash property. A
 *   stroke at zero opacity carrying a repeated two-unit stroke is how it is
 *   done, and getting it wrong leaves a *solid* line — which is exactly the
 *   claim an unclosed shape must not make.
 */
export interface DrawOverlay {
  kind: 'polygon' | 'polyline'
  path: { lat: number; lng: number }[]
  options: {
    clickable: false
    strokeColor?: string
    strokeOpacity: number
    strokeWeight: number
    fillColor?: string
    fillOpacity?: number
    icons?: {
      icon: { path: string; strokeColor: string; strokeOpacity: number; strokeWeight: number; scale: number }
      offset: string
      repeat: string
    }[]
    zIndex: number
  }
}

/**
 * Above the pins. While drawing, the shape is the subject and the leads are the
 * reference — and a vertex handle hidden behind a lead is a vertex nobody can
 * see they placed. The self-rendered map orders them the same way.
 */
export const DRAW_Z_SHAPE = 1200
export const DRAW_Z_VERTEX = 1250

/**
 * `stroke-dasharray: 6 5`, translated.
 *
 * The symbol path is two units long, so `scale: 3` draws a 6px dash, and an
 * 11px repeat leaves the 5px gap. Same rhythm as the SVG, so the two renderers
 * draw the same dashed line.
 */
const DASH_SCALE = 3
const DASH_REPEAT = '11px'

export function drawOverlay(
  points: readonly { lat: number; lng: number }[],
): DrawOverlay | null {
  if (points.length === 0) return null
  const path = points.map((p) => ({ lat: p.lat, lng: p.lng }))

  if (drawClosed(path)) {
    return {
      kind: 'polygon',
      path,
      options: {
        clickable: false,
        strokeColor: DRAW_STROKE,
        strokeOpacity: 1,
        strokeWeight: DRAW_STROKE_WIDTH,
        fillColor: DRAW_FILL,
        fillOpacity: DRAW_FILL_OPACITY,
        zIndex: DRAW_Z_SHAPE,
      },
    }
  }

  return {
    kind: 'polyline',
    path,
    options: {
      clickable: false,
      // Zero, because the dashes are the symbol below. A non-zero value here is
      // a solid line with dashes drawn on top of it.
      strokeOpacity: 0,
      strokeWeight: DRAW_STROKE_WIDTH,
      icons: [
        {
          icon: {
            path: 'M 0,-1 0,1',
            strokeColor: DRAW_STROKE,
            strokeOpacity: 1,
            strokeWeight: DRAW_STROKE_WIDTH,
            scale: DASH_SCALE,
          },
          offset: '0',
          repeat: DASH_REPEAT,
        },
      ],
      zIndex: DRAW_Z_SHAPE,
    },
  }
}

/**
 * What a tap on the map means, announced to a screen reader.
 *
 * One string, one default. `AdminLists` and `AdminLeads` each pass their own
 * label and the territory console passes none, and a renderer that invented a
 * different fallback would tell a screen-reader user a different thing about
 * the same gesture depending on which map happened to be drawing.
 */
export const DRAW_DEFAULT_LABEL = 'Outline a territory on the map'
export const MAP_DEFAULT_LABEL = 'Map of your leads'

export function mapAriaLabel(draw?: { label?: string }): string {
  return draw ? (draw.label ?? DRAW_DEFAULT_LABEL) : MAP_DEFAULT_LABEL
}

/**
 * What a tap does, given what the map is currently for.
 *
 * The whole precedence, in one place, because it is four-way and every branch
 * of it was argued somewhere:
 *
 *   **Drawing wins outright.** Selecting a pin mid-draw is wrong twice: it
 *   loses the vertex the person meant to place, and it opens a lead they were
 *   not asking about.
 *
 *   **Then the picker**, for a tap that hit nothing — or for *any* tap once the
 *   add-lead form is open. That split is the `exclusive` flag and it matters:
 *   with the picker merely armed, a tap on a house the rep already has is a
 *   question about that house, so it opens the lead as it always did. With the
 *   form open the question has already been asked, and a 22px dot sitting a few
 *   feet from the house the rep means must not hijack the answer into opening
 *   somebody else's lead over the form.
 *
 *   **Then the pin**, and finally a tap on nothing, which dismisses.
 *
 * `hitMarker` is the one input the two renderers compute differently and that
 * is fine — it is the only thing this function asks them to know. The
 * self-rendered map hit-tests the SVG itself; Google fires `gmp-click` on the
 * marker and does not fire the map's own `click` at all, so the two call sites
 * pass `true` and `false` from their own knowledge and get the same answer.
 */
export type TapIntent = 'draw' | 'pick' | 'select' | 'deselect'

export function tapIntent(state: {
  drawing: boolean
  picking: boolean
  pickExclusive: boolean
  hitMarker: boolean
}): TapIntent {
  if (state.drawing) return 'draw'
  if (state.picking && (state.pickExclusive || !state.hitMarker)) return 'pick'
  return state.hitMarker ? 'select' : 'deselect'
}
