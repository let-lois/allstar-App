import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The Android webview patch is applied, and still says what it must.
 *
 * Expo's DOM component page reads `ReactNativeWebView.injectedObjectJson()`
 * inline, synchronously, before its bundle runs, and the bundle refuses to
 * boot without the result. iOS's `react-native-webview` provides that function
 * with a WKUserScript at document start. Android's, on any WebView with
 * `WEB_MESSAGE_LISTENER`, puts an object carrying only `postMessage` on the
 * page and then defines `injectedObjectJson` with `evaluateJavascript()` —
 * which for a page with no `injectedJavaScriptBeforeContentLoaded` runs on
 * `about:blank` before the navigation and again at `onPageFinished`, never in
 * between. The page's inline script threw, the globals were never set, and the
 * phone showed a blank screen. `scripts/repro/android-injection-order.mjs`
 * reproduces both orders against the real exported page.
 *
 * The fix is the one Expo's own webview uses (`@expo/dom-webview`,
 * `DomWebView.kt`): bind `window.ReactNativeWebView` as a **JavascriptInterface**
 * whose `@JavascriptInterface injectedObjectJson()` the page calls at runtime.
 * A JavascriptInterface exists from the first line of page script in every
 * frame, by construction — no timing, no origin rule, nothing to race. A first
 * attempt used `addDocumentStartJavaScript` alongside the message listener;
 * three preview builds later it had never been seen to work, and it is gone
 * rather than kept as a second binding of the same global name.
 *
 * The patch lives in `apps/mobile/patches/`, applied by `patch-package` on
 * install. A patch is the kind of thing that quietly stops applying — the
 * dependency is bumped, `postinstall` is dropped, a fresh clone runs
 * `npm install` somewhere else — and nothing goes red until a phone does. So
 * this reads the installed module and checks what the fix depends on rather
 * than trusting that a file exists.
 *
 * The same patch keeps a release build able to say what went wrong. Upstream's
 * `onConsoleMessage` returns `true` outside `ReactBuildConfig.DEBUG`, which
 * tells WebView the message is handled, so nothing reaches logcat — and
 * `setWebContentsDebuggingEnabled` is DEBUG-only too, so `chrome://inspect` is
 * gone as well. Three preview builds showed a blank page with no way to ask
 * why. Errors now survive into logcat under `RNCWebViewConsole`.
 *
 * Chromium cannot observe any of this; only a device can. What this gate can
 * hold is that the build will compile both fixes in.
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

// The constructor alone, so "bound at construction" is checked where it is
// claimed and not satisfied by a call from a prop setter that runs later.
const ctor = (src.split('public RNCWebView(ThemedReactContext reactContext) {')[1] ?? '').split('\n    }')[0]
ok(ctor.length > 0, 'the constructor is there to read')
ok(
  /bindJavascriptInterface\(\);/.test(ctor),
  'window.ReactNativeWebView is bound in the constructor, before any prop and any load',
)
ok(
  /addJavascriptInterface\(fallbackBridge, JAVASCRIPT_INTERFACE\)/.test(src),
  'as a JavascriptInterface — present from the first line of page script by construction',
)
ok(
  /JAVASCRIPT_INTERFACE = "ReactNativeWebView"/.test(src),
  'under the exact name the DOM page calls',
)
ok(
  /@JavascriptInterface\s+public String injectedObjectJson\(\)/.test(src),
  'and the bridge answers injectedObjectJson() as a Java method the page calls at runtime',
)
ok(
  /return json == null \? "\{\}" : json;/.test(src),
  'with "{}" when unset, as Expo\'s own bridge answers, so JSON.parse never throws',
)
ok(
  /protected volatile String injectedJavaScriptObject/.test(src),
  'read across threads safely — the JavaBridge thread asks, the UI thread sets',
)
ok(
  !/addWebMessageListener\(/.test(src),
  'the message-listener binding is gone, so nothing else claims the same global name',
)
ok(
  !/addDocumentStartJavaScript\(/.test(src),
  'and no document-start script competes with it',
)

/* --- and a release build can still say what went wrong ----------------- */
//
// Without this the app is diagnosable only on a debug build, which is the one
// configuration the bug may not appear in.
const chrome = resolve(
  mobile,
  'node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebChromeClient.java',
)
const chromeSrc = existsSync(chrome) ? readFileSync(chrome, 'utf8') : ''
ok(chromeSrc.length > 0, 'the Android WebChromeClient source is present')

// Just the one method, so a match somewhere else in the file cannot stand in
// for it — and so the debug branch and the release path can be told apart.
const method = (chromeSrc.split('public boolean onConsoleMessage(ConsoleMessage message) {')[1] ?? '').split(
  '@Override',
)[0]
ok(method.length > 0, 'onConsoleMessage is there to read')
ok(
  /Log\.w\(\s*"RNCWebViewConsole"/.test(method),
  'a release build forwards console errors to logcat',
)
ok(
  /ConsoleMessage\.MessageLevel\.ERROR/.test(method),
  'at error level only, so a rep\'s day does not end up in logcat',
)
ok(
  !/MessageLevel\.(WARNING|LOG|TIP|DEBUG)\b/.test(method),
  'and no other level is forwarded',
)
ok(
  method.indexOf('MessageLevel.ERROR') > method.indexOf('ReactBuildConfig.DEBUG'),
  'below the debug branch, so it is the release path that reports',
)
ok(
  /sourceId\(\)/.test(method) && /lineNumber\(\)/.test(method),
  'with the file and line, so the message can be placed',
)

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the Android bridge is a JavascriptInterface, and a release build can still speak ===')
