import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isInspectable } from '../apps/mobile/src/lib/inspectable.ts'
import { diagnosticLines } from '../apps/mobile/src/lib/build-diagnostic.ts'

/**
 * Who can open the app's webview in a desktop inspector.
 *
 * Two failures are possible here and they are not symmetric. Closed when it
 * should be open costs a build: a preview APK renders a blank page and there is
 * no console and no inspector to ask why, which is what happened three times
 * running on Android. Open when it should be closed ships a store build whose
 * DOM, network and IndexedDB — the session token, every lead the rep has
 * touched — can be read by anyone with the app and a Mac.
 *
 * So the rule is closed by default and opens only for a channel this project
 * recognises as its own, and this gate drives every case rather than the two
 * obvious ones. The cases that matter most are the ones that are neither
 * "preview" nor "production": a null channel, an empty one, something
 * unrecognised. All of those must be shut.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const is = (dev, channel, want, why) => {
  const got = isInspectable(dev, channel)
  ok(got === want, `${why} → ${want ? 'inspectable' : 'closed'}`, got === want ? undefined : `got ${got}`)
}

console.log('--- a development machine, already talking to a device it owns ---')
is(true, null, true, '__DEV__ with no channel')
is(true, 'production', true, '__DEV__ even on the production channel')

console.log('\n--- the builds we hand out ourselves ---')
is(false, 'development', true, 'the development channel')
is(false, 'preview', true, 'the preview channel')
is(false, 'PREVIEW', true, 'the preview channel, shouted')
is(false, ' preview ', true, 'the preview channel with stray whitespace')

console.log('\n--- everything else is shut, including every way of not knowing ---')
is(false, 'production', false, 'the production channel')
is(false, null, false, 'no channel at all (updates not configured)')
is(false, undefined, false, 'an undefined channel')
is(false, '', false, 'an empty channel')
is(false, '   ', false, 'a blank channel')
is(false, 'prod', false, 'a channel nobody declared')
is(false, 'preview-device', false, 'a profile name that merely starts with one of ours')
is(false, 'previews', false, 'a channel that merely starts with one of ours')

/* --- and the shell actually asks --------------------------------------- */
//
// The function can be perfect while the route still ships Expo's `__DEV__`
// default, which is the state that costs the build.
const route = readFileSync(
  resolve(new URL('..', import.meta.url).pathname, 'apps/mobile/src/app/index.tsx'),
  'utf8',
)
console.log('')
ok(
  /isInspectable\(__DEV__, Updates\.channel\)/.test(route),
  'the shell decides with the channel, not with __DEV__ alone',
)
ok(
  /webviewDebuggingEnabled: WEBVIEW_INSPECTABLE/.test(route),
  'and hands the answer to the webview',
)
ok(
  !/webviewDebuggingEnabled: (true|__DEV__)\b/.test(route),
  'never as a bare literal, which would ship whatever it was left at',
)

/* --- the build strip borrows the same decision ------------------------- */
//
// A second "is this build ours" rule, however small, is a second thing to get
// wrong. So the diagnostic asks `isInspectable` and this drives it through the
// same cases: open where the inspector is open, nothing at all where it is
// shut — and on the production channel in particular, not one character.
console.log('\n--- the build strip: shown to us, invisible to everyone else ---')
const FACTS = {
  runtimeVersion: 'exposdk:57.0.0',
  updateId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  isEmbeddedLaunch: false,
}
const shows = (dev, channel) => diagnosticLines(dev, { ...FACTS, channel })
ok(shows(false, 'production').length === 0, 'production shows nothing')
ok(shows(false, null).length === 0, 'a null channel shows nothing')
ok(shows(false, '').length === 0, 'an empty channel shows nothing')
ok(shows(false, 'previews').length === 0, 'an unrecognised channel shows nothing')
ok(shows(false, 'preview').length > 0, 'preview shows the strip')
ok(shows(false, 'development').length > 0, 'development shows the strip')
ok(shows(true, 'production').length > 0, '__DEV__ shows it even on production, like the inspector')

const strip = shows(false, 'preview')
ok(strip.some((l) => /^BUILD: PREVIEW \(not production\)$/.test(l)), 'it says PREVIEW and not production', strip[0])
ok(strip.some((l) => l === 'CHANNEL: preview'), 'it names the channel')
ok(strip.some((l) => l === 'RUNTIME: exposdk:57.0.0'), 'it names the runtime version')
ok(strip.some((l) => l === 'UPDATE: 0f1e2d3c'), 'it shows the first eight characters of the update id')
ok(strip.some((l) => l === 'EMBEDDED: no'), 'it says whether the embedded bundle is running')
ok(
  shows(false, 'preview').every((l) => l === l.trim()) &&
    diagnosticLines(false, { ...FACTS, channel: 'preview', updateId: null }).some((l) => l === 'UPDATE: none'),
  'and copes with no update id at all',
)
// It never claims to know how it was installed: the shell cannot tell
// TestFlight from an ad hoc build, and a confident wrong label is worse than
// none on the strip whose whole purpose is telling builds apart.
ok(!strip.some((l) => /testflight|ad.?hoc/i.test(l)), 'it does not claim to know how it was installed')

// Nothing key-shaped, from any input. The facts it is given are not secrets,
// but a future field added carelessly could be, and this is where that fails.
const DIAG_SRC = readFileSync(
  resolve(new URL('..', import.meta.url).pathname, 'apps/mobile/src/lib/build-diagnostic.ts'),
  'utf8',
)
ok(!/process\.env/.test(DIAG_SRC), 'the diagnostic reads no environment variable')
ok(!/EXPO_PUBLIC|GOOGLE|MAPTILER|token|secret/i.test(DIAG_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'and its code names no key, token or provider')

// And the shell no longer draws it at all. It sat in the top-right corner of
// every preview and TestFlight build, over the screen people were testing,
// and was taken off at the owner's request. The lines above still decide what
// it would say, should it come back somewhere quieter.
const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/gm, '')
ok(!/diagnosticLines|BUILD_DIAGNOSTIC/.test(routeCode), 'the shell does not draw the build strip over the app')

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the inspector is open for our builds and shut for everyone else ===')
