import { chromium } from 'playwright'
import { readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromiumPath } from './lib/browser.mjs'

/**
 * The shell, booted the way the phone boots it.
 *
 * Every other browser gate loads the app from a dev server over `http://`.
 * That is the web app's world, and it is not the one the native app runs in:
 * Expo hands a DOM component to the webview as a **local file**, so the page's
 * origin is `file://`. Three whole classes of fault live only on that side of
 * the line and cannot be reached from `http://localhost`:
 *
 *   - an absolute asset path (`/logo.png`) resolves to the filesystem root
 *   - a *relative* asset path resolves against the bundle directory, which is
 *     not where `expo export` puts the assets
 *   - CORS: every request carries `Origin: null`, which is why the app's
 *     `fetch` is replaced by the native bridge at all
 *
 * So this gate loads the real exported bundle — `apps/mobile/dist/www.bundle`,
 * the same files EAS Update ships — from a `file://` URL, and stands in for the
 * native side exactly as `@expo/dom-webview` does: `injectedObjectJson()` for
 * the host OS and the initial props, `postMessage` for a native action, and the
 * `$$dom_event` CustomEvent that carries the result back. Nothing about the
 * bundle is stubbed or rebuilt.
 *
 * What it cannot tell you, and must not be read as telling you: this is
 * Chromium, not WKWebView and not Android's WebView. Anything that depends on
 * *those* engines' policies — Android's `domStorageEnabled` default, WKWebView's
 * missing alert/confirm delegates, the camera permission strings — is invisible
 * here and has to be established by reading the native code or by running on a
 * device. This gate covers the bundle, not the host.
 *
 *   node scripts/verify-shell.mjs            # iOS host
 *   node scripts/verify-shell.mjs android    # Android host
 *
 * Needs an export first: `cd apps/mobile && npx expo export --platform ios`.
 *
 * Deliberately *not* a `verify:` script in package.json yet, which is the only
 * reason it is not in `verify:all`: that runner discovers gates by name, and it
 * builds the web app but not the native export. A gate in the suite whose input
 * the suite does not build is the stale-`dist/` trap `verify-all.mjs` was
 * written to prevent — it would test whichever export happened to be on disk
 * and pass. It joins the suite when the runner exports first.
 */

const BUNDLE = resolve('apps/mobile/dist/www.bundle')
const HOST_OS = process.argv[2] === 'android' ? 'android' : 'ios'

/**
 * Every native action the route passes, named exactly as it is there.
 *
 * One list, used both for the initial props and for the re-render below,
 * because a `$$props` message **replaces** the marshalled props rather than
 * merging them. The first version of this gate re-rendered with `['apiFetch']`
 * alone, which silently deleted `onCanGoBack` for the rest of the run — and
 * then reported that the app had stopped tracking its history. It had not; the
 * gate had unplugged it. The wrapper marshals by prop name, so a name that
 * drifts from `src/app/index.tsx` tests a bridge the app does not have.
 */
const ACTIONS = ['apiFetch', 'onCanGoBack']

if (!existsSync(BUNDLE)) {
  console.error(
    `FAIL  no export at ${BUNDLE}\n` +
      `      run: cd apps/mobile && npx expo export --platform ios`,
  )
  process.exit(1)
}

const html = readdirSync(BUNDLE).find((f) => f.endsWith('.html'))
if (!html) {
  console.error(`FAIL  ${BUNDLE} has no .html entry — the export is incomplete`)
  process.exit(1)
}

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/*
  The native side of the bridge.

  Kept faithful to `expo/src/dom` rather than convenient: the page reads the
  host OS and its props out of `ReactNativeWebView.injectedObjectJson()`, posts
  a `$$native_action` message per call, and waits for a `$$dom_event` carrying
  `$$native_action_result` with the same uid. Getting any of that wrong would
  make this gate pass while the app hung on the phone.
*/
function nativeSide({ hostOs, actions }) {
  const NATIVE_ACTION = '$$native_action'
  const NATIVE_ACTION_RESULT = '$$native_action_result'
  const DOM_EVENT = '$$dom_event'

  globalThis.__calls = []

  const json = (status, body) => ({
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    isBase64: false,
  })

  const USER = {
    id: 'u1',
    clientId: 'c1',
    clientName: 'Test Co',
    email: 'rep@example.com',
    name: 'Test Rep',
    role: 'field_rep',
  }

  async function apiFetch(req) {
    globalThis.__calls.push({ url: req.url, method: req.method, hasAuth: 'authorization' in req.headers })
    const path = new URL(req.url).pathname
    if (path === '/api/auth/login') {
      const sent = JSON.parse(req.body ?? '{}')
      if (sent.email === USER.email && sent.password === 'correct-horse') {
        return json(200, { token: 'test-token', user: USER })
      }
      return json(401, { error: 'Wrong email or password.' })
    }
    if (path === '/api/me') return json(200, { user: USER })
    if (path === '/api/bootstrap') {
      return json(200, { properties: [], leads: [], visits: [], users: [USER], lists: [] })
    }
    return json(404, { error: `not stubbed: ${path}` })
  }

  window.ReactNativeWebView = {
    injectedObjectJson: () =>
      JSON.stringify({
        EXPO_DOM_HOST_OS: hostOs,
        // Both native actions the route passes. Named exactly as there: the
        // wrapper marshals by prop name, so a rename here would test a bridge
        // the app does not have.
        initialProps: { names: actions, props: {} },
      }),
    postMessage: (raw) => {
      const msg = JSON.parse(raw)
      if (msg.type !== NATIVE_ACTION) return
      const { uid, actionId, args } = msg.data
      const reply = (detail) => window.dispatchEvent(new CustomEvent(DOM_EVENT, { detail }))
      if (actionId === 'onCanGoBack') {
        globalThis.__canGoBack = args[0]
        reply({ type: NATIVE_ACTION_RESULT, data: { uid, actionId, result: null } })
        return
      }
      if (actionId !== 'apiFetch') {
        reply({
          type: NATIVE_ACTION_RESULT,
          data: { uid, actionId, error: { name: 'Error', message: `no such action ${actionId}` } },
        })
        return
      }
      Promise.resolve()
        .then(() => apiFetch(...args))
        .then((result) => reply({ type: NATIVE_ACTION_RESULT, data: { uid, actionId, result } }))
        .catch((e) =>
          reply({
            type: NATIVE_ACTION_RESULT,
            data: { uid, actionId, error: { name: e.name, message: e.message } },
          }),
        )
    },
  }
}

const browser = await chromium.launch({ executablePath: chromiumPath() })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
})
/*
  A local file the bundle asked for and did not get. This is the whole reason
  the gate exists: the request is for a path the bundle itself wrote, so a miss
  is an asset the app cannot load on a phone however the bundler named it.
*/
page.on('requestfailed', (r) => {
  if (r.url().startsWith('file://')) {
    errors.push(`missing file: ${r.url().slice(`file://${BUNDLE}/`.length)}`)
  }
})

await page.addInitScript(nativeSide, { hostOs: HOST_OS, actions: ACTIONS })
await page.goto(`file://${resolve(BUNDLE, html)}`, { waitUntil: 'load' })

// The app boots asynchronously — the store reads storage before it renders.
await page.waitForFunction(() => document.body.innerText.length > 0, null, { timeout: 20_000 })

console.log(`\n--- ${HOST_OS} host, file:// origin ---`)

/* 1. It boots at all, and lands on the one screen a signed-out rep should see. */
const text = await page.evaluate(() => document.body.innerText)
ok(/Sign in/i.test(text), 'the app boots and renders the sign-in screen')

/* 2. Every image the bundle asked for actually decoded.
      Asked of the DOM rather than of the network, because `requestfailed` is a
      race: the boot wait returns as soon as there is text on screen, which can
      be before an `<img>` has finished failing. `naturalWidth` is settled once
      `complete` is true, and a broken image is exactly what the phone shows. */
const broken = await page.evaluate(async () => {
  await Promise.all(
    [...document.images].map(
      (i) =>
        i.complete ||
        new Promise((res) => {
          i.addEventListener('load', res, { once: true })
          i.addEventListener('error', res, { once: true })
        }),
    ),
  )
  return [...document.images].filter((i) => i.naturalWidth === 0).map((i) => i.currentSrc || i.src)
})
ok(
  broken.length === 0,
  `every image decoded${broken.length ? ` \u2014 broken: ${broken.map((u) => u.split('/').pop()).join(', ')}` : ''}`,
)

/* 3. The shell's two corrections to Expo's page box took effect. */
const box = await page.evaluate(() => ({
  viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
  styled: !!document.getElementById('allstar-shell-box'),
  rootDisplay: getComputedStyle(document.getElementById('root')).display,
  bodyMargin: getComputedStyle(document.body).marginLeft,
}))
ok(box.viewport.includes('viewport-fit=cover'), 'viewport carries viewport-fit=cover, so the safe-area insets resolve')
/*
  And page zoom is off, which the web app deliberately allows and the shell
  deliberately does not. `FieldMap` has its own pinch handler, so on the map one
  gesture zoomed both the map and the page — and the page zoom survived
  navigation, leaving a rep magnified on Overview with no way back.
*/
ok(
  box.viewport.includes('user-scalable=no'),
  'and user-scalable=no, so pinching the map cannot zoom the page with it',
)
ok(box.styled, 'the shell stylesheet is installed')
ok(box.rootDisplay === 'block', `#root is not left as Expo's flex child (got ${box.rootDisplay})`)
ok(box.bodyMargin === '0px', `body margin is reset (got ${box.bodyMargin})`)

/* 4. `fetch` was replaced before anything could use the browser's own. */
ok(
  await page.evaluate(() => !String(window.fetch).includes('[native code]')),
  'fetch is the bridge, not the webview’s own',
)

/* 5. The app fits the screen it was given. A horizontal scrollbar here is the
      "page does not fit the phone" report, reproduced. */
const fit = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
  scrollH: document.documentElement.scrollHeight,
  clientH: document.documentElement.clientHeight,
}))
ok(fit.scrollW <= fit.clientW, `no horizontal overflow (${fit.scrollW} > ${fit.clientW})`)
ok(fit.scrollH <= fit.clientH, `no page-level vertical overflow (${fit.scrollH} > ${fit.clientH})`)

/* 5b. A re-render does not add a second copy of anything.
      The shell installs the stylesheet and the fetch proxy in the component
      body rather than an effect — it has to, because React renders a parent
      before its children and an effect would run after the first request had
      gone out through the browser. The cost is that this runs again every time
      the native side emits props, which it does on each of its own renders.
      Provoked here exactly as the native side does it: a `$$dom_event`
      carrying `$$props`, which the DOM root turns into `setProps`. */
const beforeRender = await page.evaluate(
  () => document.querySelectorAll('#allstar-shell-box').length,
)
await page.evaluate((NAMES) => {
  for (let i = 0; i < 5; i++) {
    window.dispatchEvent(
      new CustomEvent('$$dom_event', {
        detail: { type: '$$props', data: { names: NAMES, props: {} } },
      }),
    )
  }
}, ACTIONS)
await page.waitForTimeout(500)
const afterRender = await page.evaluate(() => ({
  styles: document.querySelectorAll('#allstar-shell-box').length,
  viewports: document.querySelectorAll('meta[name="viewport"]').length,
}))
ok(
  beforeRender === 1 && afterRender.styles === 1,
  'five re-renders leave exactly one shell stylesheet',
  `${beforeRender} before, ${afterRender.styles} after`,
)
ok(afterRender.viewports === 1, `and one viewport tag (${afterRender.viewports})`)

/* 6. Sign-in, end to end, over the bridge. Wrong credentials first, so a gate
      that only ever saw success cannot pass on an app that accepts anything. */
await page.getByLabel('Email').fill('rep@example.com')
await page.getByLabel('Password').fill('wrong')
await page.getByRole('button', { name: /^Sign in$/ }).click()
await page.waitForTimeout(1500)
const refused = await page.evaluate(() => document.body.innerText)
ok(/wrong email or password/i.test(refused), 'wrong credentials are refused, with the server’s own message')

await page.getByLabel('Password').fill('correct-horse')
await page.getByRole('button', { name: /^Sign in$/ }).click()
await page.waitForTimeout(3000)
const signedIn = await page.evaluate(() => document.body.innerText)
ok(!/Sign in/i.test(signedIn), 'correct credentials sign the rep in')

const calls = await page.evaluate(() => globalThis.__calls)
ok(
  calls.some((c) => c.url.endsWith('/api/auth/login') && c.method === 'POST'),
  'the login request crossed the native bridge',
)
ok(
  calls.some((c) => c.hasAuth),
  'the token is sent on requests after sign-in',
)

/* 7. Android's back button, as far as Chromium can see it.
      The native half is `BackHandler`, which does not exist here — so what
      this establishes is that the web side counts its own history correctly
      and that `goBack` navigates. Whether Android's button is wired to it
      needs a device, and is said so in the audit.

      Driven through the same channels the native side uses: the `onCanGoBack`
      native action arrives as a `$$native_action` message, and `goBack` is
      called through `window._domRefProxy`, which is what the wrapper's ref
      proxy injects. */
{
  const reported = await page.evaluate(() => globalThis.__canGoBack)
  ok(reported === false, `at the home screen, back is not possible (reported ${reported})`)

  ok(
    await page.evaluate(() => typeof globalThis._domRefProxy?.goBack === 'function'),
    'the shell publishes a goBack handle for the native side to call',
  )

  /*
    The first-run tour sits over the bottom dock, so it has to go before the
    dock can be tapped. Skipping it is also the honest thing to drive: a rep
    who skips the tour is the one most likely to reach for back.
  */
  const skip = page.getByRole('button', { name: 'Skip' })
  if (await skip.count()) {
    await skip.first().click()
    await page.waitForTimeout(600)
  }

  // Navigate with the app's own navigation, so this is a real push rather than
  // a synthetic history entry.
  await page.getByRole('link', { name: 'More' }).click()

  /*
    Waited for, not slept on. The report crosses the bridge as a native action
    — postMessage out, CustomEvent back — after an effect has flushed, and a
    fixed 900ms was enough on one run and not the next. A sleep here makes this
    gate fail for a reason that has nothing to do with the app, which is the
    same mistake `verify-lists-e2e` was carrying.
  */
  let deeper = null
  try {
    await page.waitForFunction(() => globalThis.__canGoBack === true, null, { timeout: 10_000 })
    deeper = true
  } catch {
    deeper = await page.evaluate(() => globalThis.__canGoBack)
  }
  ok(deeper === true, `one screen in, back becomes possible (reported ${deeper})`)

  const before = await page.evaluate(() => document.body.innerText.slice(0, 80))
  await page.evaluate(() => globalThis._domRefProxy.goBack())
  /*
    Reported rather than thrown. Waiting and letting the timeout escape would
    kill the gate on the one failure this check exists to describe, and the
    remaining checks would never run.
  */
  let left = false
  try {
    await page.waitForFunction(
      (was) => document.body.innerText.slice(0, 80) !== was,
      before,
      { timeout: 10_000 },
    )
    left = true
  } catch {
    left = false
  }
  ok(left, 'calling goBack actually leaves the screen')
  let home = null
  try {
    await page.waitForFunction(() => globalThis.__canGoBack === false, null, { timeout: 10_000 })
    home = false
  } catch {
    home = await page.evaluate(() => globalThis.__canGoBack)
  }
  ok(home === false, `and back becomes impossible again at the bottom of the stack (${home})`)
}

/* 8. Nothing threw on the way. */
ok(errors.length === 0, `no runtime errors${errors.length ? `:\n      ${errors.join('\n      ')}` : ''}`)

await browser.close()

console.log(
  fails.length ? `\n${fails.length} of the shell checks failed.` : `\nThe shell boots clean on ${HOST_OS}.`,
)
process.exit(fails.length ? 1 : 0)
