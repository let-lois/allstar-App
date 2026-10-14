import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Android release, against what Google Play enforces on upload.
 *
 * Every one of these fails at the Play Console rather than at build time — a
 * twenty-minute EAS build that produces an APK instead of a bundle, a target
 * SDK a year behind Play's floor, a release the API refuses because a brand
 * new app may only take drafts, a permission that adds a Data safety line and
 * a review question for something the app never does. Pinned here so they are
 * found by `npm run verify:android-release` instead.
 *
 * Read from the files the build reads: app.json, eas.json, React Native's
 * version catalog (which is where Expo SDK 57 takes compileSdk/targetSdk from
 * when nothing overrides them), and git's own list of tracked files.
 *
 * Pure Node. Nothing here builds, signs or uploads anything.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mobile = resolve(root, 'apps/mobile')
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}

const app = JSON.parse(readFileSync(resolve(mobile, 'app.json'), 'utf8')).expo
const eas = JSON.parse(readFileSync(resolve(mobile, 'eas.json'), 'utf8'))
const android = app.android ?? {}

console.log('--- identity ---')
// The package is permanent once the first bundle reaches Play: it cannot be
// renamed, only replaced by a different app with no installs and no reviews.
ok(android.package === 'com.allstarhomesolutions.allstar', 'the package name is the one registered for this app', android.package)
ok(app.ios?.bundleIdentifier === android.package, 'and matches the iOS bundle identifier, so the two stores name one product')
ok(/^\d+\.\d+\.\d+$/.test(app.version), 'the version is semantic, which is what Play shows as the version name', app.version)
ok(eas.cli?.appVersionSource === 'remote' && eas.build?.production?.autoIncrement === true,
  'versionCode is EAS-managed and rises on every production build — Play refuses a repeated one')

console.log('\n--- the build Play takes ---')
const prodAndroid = eas.build?.production?.android ?? {}
ok((prodAndroid.buildType ?? 'app-bundle') === 'app-bundle', 'the production profile builds an Android App Bundle (.aab), not an APK', prodAndroid.buildType ?? 'default')
ok(prodAndroid.buildType === 'app-bundle', 'and says so explicitly, so a later edit cannot quietly change it')
ok(eas.build?.production?.channel === 'production', 'a store build listens on the production update channel')
ok(eas.build?.preview?.android?.buildType === 'apk', 'the internal preview stays an installable APK')

const catalog = readFileSync(resolve(mobile, 'node_modules/react-native/gradle/libs.versions.toml'), 'utf8')
const v = (k) => Number(new RegExp(`^${k}\\s*=\\s*"(\\d+)"`, 'm').exec(catalog)?.[1])
const plugins = (app.plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p))
const overridden = plugins.includes('expo-build-properties')
ok(!overridden, 'no expo-build-properties override, so the SDK levels below are the ones the build uses')
ok(v('targetSdk') >= 36, 'targets Android 16 (API 36) or later, as Play requires of new apps', v('targetSdk'))
ok(v('compileSdk') >= v('targetSdk'), 'compiles against at least the target', v('compileSdk'))
ok(v('minSdk') >= 24 && v('minSdk') <= 26, 'runs on Android 7.0 (API 24) and later', v('minSdk'))

console.log('\n--- permissions ---')
const declared = new Set(android.permissions ?? [])
const expected = ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'RECORD_AUDIO']
ok(expected.every((p) => declared.has(p)) && declared.size === expected.length,
  'exactly location (while in use) and the microphone (note dictation) are requested', [...declared].join(', '))
for (const p of ['ACCESS_BACKGROUND_LOCATION', 'CAMERA', 'POST_NOTIFICATIONS', 'READ_MEDIA_IMAGES', 'READ_CONTACTS', 'QUERY_ALL_PACKAGES', 'com.google.android.gms.permission.AD_ID']) {
  ok(!declared.has(p) && !declared.has(`android.permission.${p}`), `${p} is not requested`)
}
const blocked = new Set(android.blockedPermissions ?? [])
for (const p of ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW']) {
  // Template and library defaults the app never uses: photos come through the
  // system picker or the camera app into app-private storage, files leave
  // through the share sheet, and nothing draws over other apps.
  ok(blocked.has(`android.permission.${p}`), `${p} is stripped from the merged manifest, including library copies`)
}

console.log('\n--- what the phone keeps ---')
// The webview's IndexedDB holds the session token and the homeowner details a
// rep has touched; Android's auto-backup would copy it to the cloud and onto
// the next phone restored from it.
ok(android.allowBackup === false, 'Android backup is off, so the session and lead data are not copied off the device')
ok(android.adaptiveIcon?.foregroundImage && existsSync(resolve(mobile, android.adaptiveIcon.foregroundImage)), 'the adaptive icon foreground exists')
ok(android.adaptiveIcon?.monochromeImage && existsSync(resolve(mobile, android.adaptiveIcon.monochromeImage)), 'and a monochrome layer for themed icons')

console.log('\n--- publishing ---')
const submit = eas.submit?.production?.android ?? {}
ok(submit.track === 'internal', 'EAS Submit sends to the internal testing track, never straight to production', submit.track)
// Google's publishing API refuses any other status until the app has been
// published once; a "completed" release on a new app fails at upload.
ok(submit.releaseStatus === 'draft', 'as a draft release, which is the only kind a never-published app accepts', submit.releaseStatus)
ok(!submit.serviceAccountKeyPath, 'with no key path in the repo — the service-account key lives in EAS credentials')

console.log('\n--- nothing secret is tracked ---')
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
const secret = tracked.filter((f) => /\.(jks|keystore|p8|p12)$/i.test(f) || /service-account.*\.json$|google-services\.json$|google-play-.*\.json$|(^|\/)credentials\.json$/i.test(f))
ok(secret.length === 0, 'no keystore, upload key, or Play service-account key is committed', secret.join(', ') || 'none')
const ignore = readFileSync(resolve(mobile, '.gitignore'), 'utf8')
ok(['*.jks', '*.keystore', 'credentials.json', '*service-account*.json'].every((g) => ignore.includes(g)), 'and the mobile .gitignore keeps them out')

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed`)
  process.exit(1)
}
console.log('=== the Android release is what Google Play accepts ===')
