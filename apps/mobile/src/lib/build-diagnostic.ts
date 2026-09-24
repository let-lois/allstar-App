import { isInspectable } from './inspectable'

/**
 * What the shell says about itself, on builds that are ours to inspect.
 *
 * Two TestFlight builds of this app can be on a phone in the same week with
 * the same icon, the same name and the same bundle identifier — one made from
 * the `production` profile and one from `testflight-preview` — and nothing on
 * the home screen tells them apart. The difference is the EAS channel baked
 * into the binary, and it decides everything downstream: which updates the
 * app fetches, which environment's variables were compiled in, whether the
 * Google map is on. Testing the wrong one for an afternoon is the failure this
 * exists to make impossible.
 *
 * ## Why it is gated the same way as the inspector
 *
 * `isInspectable()` is already this project's answer to "is this build ours to
 * look inside": closed by default, open only for a channel we recognise as
 * internal, with every way of *not knowing* — null, empty, unrecognised —
 * treated as production. A strip of build metadata is a milder exposure than
 * an open Web Inspector, but it is the same question, and two answers to one
 * question drift. So it borrows the decision rather than making a second one.
 * That is strictly narrower than `channel !== 'production'`: a store build
 * whose channel somehow came back null shows nothing, which is the right
 * failure.
 *
 * ## What it never shows
 *
 * Nothing here is a credential. The channel, the runtime version and an
 * update id are what `eas build:view` and `eas update:view` print to anyone
 * with dashboard access, and an update id is a UUID that opens nothing. No
 * environment variable is read, so the Google key — which is compiled into
 * the *web* bundle, not this native one — cannot reach it by accident.
 *
 * Pure, and kept out of the route so a Node gate can drive every case
 * without a phone, the same way `inspectable.ts` and `handoff.ts` are.
 */

export interface BuildFacts {
  /** `Updates.channel` — null when updates are not configured. */
  channel: string | null | undefined
  /** `Updates.runtimeVersion` */
  runtimeVersion: string | null | undefined
  /** `Updates.updateId` — null for an embedded launch on some platforms. */
  updateId: string | null | undefined
  /** `Updates.isEmbeddedLaunch` — true when running the bundle shipped in the binary. */
  isEmbeddedLaunch: boolean
}

/**
 * The lines to draw, or none.
 *
 * Empty for every build this must never appear on. Callers render nothing
 * for an empty list rather than an empty box, so "closed" leaves no trace.
 *
 * @param dev `__DEV__`
 */
export function diagnosticLines(dev: boolean, facts: BuildFacts): string[] {
  if (!isInspectable(dev, facts.channel)) return []
  const channel = (facts.channel ?? 'null').trim().toLowerCase()
  return [
    // Named for what the channel *is*, not for how it was installed. The
    // shell cannot tell TestFlight from an ad hoc install, and claiming it
    // could would be the kind of confident wrong answer this strip exists to
    // prevent. "Preview" is the fact that matters: not production.
    `BUILD: ${channel === 'preview' ? 'PREVIEW' : channel.toUpperCase()} (not production)`,
    `CHANNEL: ${facts.channel ?? 'null'}`,
    `RUNTIME: ${facts.runtimeVersion ?? 'null'}`,
    // The first eight characters are enough to match against `eas update:list`
    // and short enough to read off a phone held at arm's length.
    `UPDATE: ${facts.updateId ? facts.updateId.slice(0, 8) : 'none'}`,
    `EMBEDDED: ${facts.isEmbeddedLaunch ? 'yes' : 'no'}`,
  ]
}
