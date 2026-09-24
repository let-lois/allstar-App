import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The EAS build profiles say what they are supposed to say — and production
 * says exactly what it said yesterday.
 *
 * `eas.json` is configuration that decides which phone gets which code:
 * `channel` picks the updates a binary will ever fetch, `distribution` picks
 * whether it can reach TestFlight, `environment` picks which set of variables
 * — and therefore which Google key, or none — is compiled in. None of it is
 * exercised by any other gate, and a wrong value produces no error anywhere:
 * the build succeeds, uploads, installs, and quietly does the wrong thing for
 * as long as nobody checks.
 *
 * `testflight-preview` exists so a Google Maps build can be tested through
 * TestFlight on a real iPhone without touching production. Its safety rests
 * on three facts that this gate pins:
 *
 *   - it listens to `preview`, so a production OTA can never reach it and a
 *     preview OTA always can;
 *   - it compiles the `preview` environment, so the preview key is the only
 *     key it can carry;
 *   - the `production` profile is untouched — asserted as deep equality
 *     against the shape it had, so a well-meant edit that "just tidies both"
 *     fails here before it ships.
 */

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const root = resolve(new URL('..', import.meta.url).pathname)
const eas = JSON.parse(readFileSync(resolve(root, 'apps/mobile/eas.json'), 'utf8'))
const app = JSON.parse(readFileSync(resolve(root, 'apps/mobile/app.json'), 'utf8')).expo
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* --- production, frozen -------------------------------------------------- */
//
// The literal shape, not a description of it. A description ("has channel
// production") passes when somebody adds `environment: preview` by mistake;
// equality does not.
const PRODUCTION = {
  autoIncrement: true,
  android: { image: 'latest' },
  ios: { image: 'latest' },
  channel: 'production',
}
ok(same(eas.build.production, PRODUCTION), 'the production build profile is unchanged', JSON.stringify(eas.build.production))
ok(
  same(eas.submit.production, { ios: { ascAppId: '6813645551' }, android: { track: 'internal' } }),
  'and so is the production submit profile',
)
ok(eas.build.production.distribution === undefined, 'production distribution is the store default, not restated')
ok(eas.build.production.environment === undefined, 'production environment is the store default, not restated')

/* --- testflight-preview -------------------------------------------------- */
const tp = eas.build['testflight-preview']
ok(!!tp, 'a testflight-preview build profile exists')
ok(tp?.distribution === 'store', 'it is a store build, so it can be uploaded to TestFlight', tp?.distribution)
ok(tp?.channel === 'preview', 'it listens to the preview channel', tp?.channel)
ok(tp?.environment === 'preview', 'it compiles the preview environment — written, not inferred', tp?.environment)
ok(tp?.autoIncrement === true, 'it takes the next build number from EAS like production does')
ok(tp?.ios?.simulator !== true, 'it is not a simulator build')
ok(tp?.extends === undefined, 'it inherits from nothing, so a later change to production cannot leak into it')
ok(tp?.developmentClient !== true, 'it is a release build, not a dev client')
// One record in App Store Connect per bundle identifier, so the submit profile
// must point at the same app as production does — a different id would be a
// different app, and a missing profile would make `eas submit` guess.
ok(
  same(eas.submit['testflight-preview'], { ios: { ascAppId: '6813645551' } }),
  'its submit profile targets the same App Store Connect record as production',
)

/* --- the two profiles it must not be confused with ----------------------- */
ok(eas.build.preview?.ios?.simulator === true, 'preview is still the simulator profile (it cannot install on a phone)')
ok(eas.build['preview-device']?.extends === 'preview', 'preview-device still extends preview')
ok(eas.build['preview-device']?.ios?.simulator === false, 'and is still a device build')
ok(eas.build['preview-device']?.channel === undefined, 'preview-device still inherits its channel rather than restating it')

/* --- exactly one profile may reach the production channel ---------------- */
const onProduction = Object.entries(eas.build)
  .filter(([, p]) => p.channel === 'production')
  .map(([n]) => n)
ok(same(onProduction, ['production']), 'only the production profile listens to production', onProduction.join(','))

/* --- what makes the preview OTA compatible ------------------------------- */
ok(app.runtimeVersion?.policy === 'sdkVersion', 'runtime version follows the SDK, so every profile shares exposdk:<sdk>')
ok(app.ios?.bundleIdentifier === 'com.allstarhomesolutions.allstar', 'the bundle identifier is unchanged')
ok(typeof app.updates?.url === 'string' && app.updates.url.includes('497739ce'), 'updates point at this project')
ok(eas.cli?.appVersionSource === 'remote', 'build numbers come from EAS, so two store profiles cannot collide')

console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== EAS profiles say what they mean ===')
process.exit(fails.length ? 1 : 0)
