import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The Android webview patch is applied, and still says what it must.
 *
 * Expo's DOM component page reads `ReactNativeWebView.injectedObjectJson()`
 * inline, synchronously, before its bundle runs, and the bundle refuses to
 * boot without the result. iOS's `react-native-webview` provides that function
 * with a WKUserScript at document start. Android's provides it with
 * `evaluateJavascript()`, which for a page with no
 * `injectedJavaScriptBeforeContentLoaded` runs on `about:blank` before the
 * navigation and again at `onPageFinished` — never in between. The page's
 * inline script threw, the globals were never set, and the phone showed a black
 * screen. `scripts/repro/android-injection-order.mjs` reproduces both orders
 * against the real exported page.
 *
 * The fix is native and lives in `apps/mobile/patches/`, applied by
 * `patch-package` on install. A patch is the kind of thing that quietly stops
 * applying — the dependency is bumped, `postinstall` is dropped, a fresh clone
 * runs `npm install` somewhere else — and nothing goes red until a phone does.
 * So this reads the installed module and checks the three things the fix
 * depends on rather than trusting that a file exists.
 *
 * Chromium cannot observe any of this; only a device can. What this gate can
 * hold is that the build will compile the fix in.
 */

const root = resolve(new URL('..', import.meta.url).pathname)
const mobile = resolve(root, 'apps/mobile')
const pkg = JSON.parse(readFileSync(resolve(mobile, 'package.json'), 'utf8'))

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/* --- the patch is wired to run ---------------------------------------- */
const version = pkg.dependencies?.['react-native-webview'] ?? ''
ok(version.length > 0, 'react-native-webview is a dependency of the mobile app', version)
ok(
  /\bpatch-package\b/.test(pkg.scripts?.postinstall ?? ''),
  'postinstall runs patch-package, so a fresh install carries the fix',
  pkg.scripts?.postinstall ?? '(no postinstall)',
)
ok(
  !!pkg.devDependencies?.['patch-package'],
  'and patch-package is declared, not assumed to be on the machine',
)

/* --- the patch file matches the installed version ---------------------- */
const installedPkg = resolve(mobile, 'node_modules/react-native-webview/package.json')
const installed = existsSync(installedPkg) ? JSON.parse(readFileSync(installedPkg, 'utf8')).version : null
ok(installed !== null, 'react-native-webview is installed under apps/mobile', installed ?? 'missing')
const patchFile = resolve(mobile, `patches/react-native-webview+${installed}.patch`)
ok(
  existsSync(patchFile),
  `a patch exists for the installed version`,
  `patches/react-native-webview+${installed}.patch`,
)

/* --- and the installed source actually carries it ---------------------- */
//
// This is the assertion with teeth. The other four can all be true while the
// module on disk is pristine — patch-package refused a hunk, or somebody ran
// `npm ci` in a way that skipped the workspace's postinstall — and that is the
// state that ships a black screen with every check above green.
const java = resolve(
  mobile,
  'node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java',
)
const src = existsSync(java) ? readFileSync(java, 'utf8') : ''
ok(src.length > 0, 'the Android WebView source is present')
ok(
  /WebViewCompat\.addDocumentStartJavaScript\(/.test(src),
  'injectedObjectJson is registered as a document-start script',
)
ok(
  /WebViewFeature\.DOCUMENT_START_SCRIPT/.test(src),
  'behind the feature check, so an old WebView falls back rather than crashes',
)
ok(
  /JSONObject\.quote\(injectedJavaScriptObject\)/.test(src),
  'and the value is quoted as JSON, not pasted into a template literal',
)
ok(
  /\.injectedObjectJson = function \(\) \{ return /.test(src),
  'under the exact name the DOM page calls',
)

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the Android injectedObjectJson patch is applied ===')
