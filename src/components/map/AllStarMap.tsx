import { useCallback, useState, type ComponentProps } from 'react'
import { FieldMap } from './FieldMap'
import { GoogleFieldMap } from './GoogleFieldMap'
import { GmapsError, gmapsConfigured } from '../../lib/gmaps'

/**
 * The map, whichever one this deployment can draw.
 *
 * Every screen with a map renders this and nothing else. That is the whole
 * point of it, and it is a rule the gate enforces: before this existed, six
 * screens each decided for themselves, and they did not agree.
 *
 *   `MapScreen` and `Navigate` each kept their own `useGoogle` boolean and
 *   their own failure state, written months apart and drifting — one reset the
 *   route line on failure, the other did not.
 *
 *   `AdminTerritories`, `AdminLists`, `AdminLeads` and `RepDetail` did not
 *   decide at all. They named `FieldMap` directly, because the Google renderer
 *   had no `draw` and three of those four screens draw. So the console was
 *   permanently on the schematic map — on a deployment with Google keys set,
 *   configured and paid for, an operator outlining a territory got the drawn
 *   grid while the rep looking at the same leads got satellite imagery. Nothing
 *   reported it; both maps work.
 *
 * So the decision moves here, once:
 *
 *   Google configured, and drawing          → `GoogleFieldMap`
 *   not configured, or it failed            → `FieldMap`
 *
 * **The fallback is not a degraded mode and is not going away.** It is the map
 * with no signal, the map on a device whose WebGL is blocked, and the map for a
 * deployment that has no Google account. It draws its own basemap from
 * arithmetic and needs nothing from anybody, which is the property that makes
 * it worth keeping however good the other one gets.
 */

/**
 * Exactly `FieldMap`'s props. Written this way rather than restated, so that a
 * prop added to one renderer and not the other stops the build here instead of
 * being discovered on a phone: this type is handed to `GoogleFieldMap` below,
 * and TypeScript checks it accepts every one of them.
 */
export type AllStarMapProps = ComponentProps<typeof FieldMap> & {
  /**
   * Called when Google could not be used, with the named reason.
   *
   * The fallback has already happened by the time this fires — this component
   * does not ask permission, because a screen with no map is worse than a
   * schematic one every time. It is for screens that want to *say* something
   * about it: the map screen shows a banner naming the reason, and the navigate
   * screen uses it to stop claiming a walking route it can no longer draw.
   *
   * Screens that have nothing to say pass nothing, which is most of them.
   */
  onUnavailable?: (err: GmapsError) => void
}

export function AllStarMap({ onUnavailable, ...props }: AllStarMapProps) {
  /*
    Held here rather than by the screen. Every screen that owned this state had
    to remember to (a) create it, (b) clear the Google renderer on failure and
    (c) never set it back — and a screen that got any of the three wrong either
    never fell back or flickered between renderers forever.
  */
  const [dead, setDead] = useState<GmapsError | null>(null)

  const fell = useCallback(
    (err: GmapsError) => {
      /*
        First reason only. `GoogleFieldMap` can report more than once — the load
        rejects, and then the paint watchdog fires — and a screen showing the
        reason should keep the first, which is the true cause. The second is a
        consequence of the map having been torn down.
      */
      setDead((was) => was ?? err)
      onUnavailable?.(err)
    },
    [onUnavailable],
  )

  /*
    `gmapsConfigured()` is a build-time constant folded by the bundler, so with
    no key this expression is provably false and rollup drops `GoogleFieldMap`,
    the marker clusterer and supercluster out of the bundle entirely — about
    45 kB a rep on cellular would otherwise download and never run. Keeping the
    call here, unwrapped, is what preserves that: hiding it behind a hook or a
    context value would make the branch un-analysable and ship the lot.
  */
  if (gmapsConfigured() && !dead) {
    return <GoogleFieldMap {...props} onUnavailable={fell} />
  }
  return <FieldMap {...props} />
}
