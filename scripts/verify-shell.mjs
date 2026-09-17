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
function nativeSide(hostOs) {
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
        initialProps: { names: ['apiFetch'], props: {} },
      }),
    postMessage: (raw) => {
      const msg = JSON.parse(raw)
      if (msg.type !== NATIVE_ACTION) return
      const { uid, actionId, args } = msg.data
      const reply = (detail) => window.dispatchEvent(new CustomEvent(DOM_EVENT, { detail }))
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

await page.addInitScript(nativeSide, HOST_OS)
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

/* 7. Nothing threw on the way. */
ok(errors.length === 0, `no runtime errors${errors.length ? `:\n      ${errors.join('\n      ')}` : ''}`)

await browser.close()

console.log(
  fails.length ? `\n${fails.length} of the shell checks failed.` : `\nThe shell boots clean on ${HOST_OS}.`,
)
process.exit(fails.length ? 1 : 0)
