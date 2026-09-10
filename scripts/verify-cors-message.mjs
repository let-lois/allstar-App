import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'

/**
 * "Couldn't reach the server" was wrong, and wrong in a costly direction.
 *
 * When this deployment's address is missing from the API's allowed origins, the
 * server answers every request correctly and the browser discards every reply.
 * `fetch` reports that as the same bare TypeError as a dead network — on
 * purpose, so a page cannot probe other people's servers — so the app said
 * "try again in a moment" and whoever was reading it went to look at the
 * signal. It is a configuration mismatch: retrying never fixes it, and the
 * server-side log was the only place the real cause appeared.
 *
 * I hit this myself standing up a local stack for a walkthrough, which is how
 * it got written down.
 *
 * ## What is simulated, and what that is worth
 *
 * A browser cannot be made to produce a genuine CORS refusal against a stubbed
 * server, so the shape is reproduced instead: the sign-in request is aborted —
 * which is exactly what a discarded reply looks like to `fetch` — and the
 * reachability probe is answered or not. That is the whole of the logic under
 * test, because the *only* thing distinguishing the two cases in the product is
 * whether that probe comes back.
 *
 * Both directions matter, and the second is the control: a genuinely dead link
 * must still say "couldn't reach", or the fix has simply moved the wrong
 * message onto the other failure.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })

/**
 * Try to sign in with the login request failing, and report what was shown.
 *
 * `probeAnswers` decides whether the reachability check gets a reply, which is
 * the one input that separates "blocked" from "unreachable".
 */
async function signInWith({ probeAnswers }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  let probes = 0

  await page.route('**/api/health*', async (route) => {
    probes += 1
    if (probeAnswers) await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    else await route.abort()
  })
  // The sign-in itself always fails, and aborting is what a reply the browser
  // refuses to hand over looks like from inside `fetch`.
  await page.route('**/api/auth/login', (route) => route.abort())

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.locator('input[type="email"]').fill('nadia@ridgeline.test')
  await page.locator('input[autocomplete="current-password"]').fill('some-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(2500)

  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  await ctx.close()
  return { text, probes }
}

try {
  /* ===== the server is there; the browser threw the reply away ========== */
  {
    const { text, probes } = await signInWith({ probeAnswers: true })
    ok(probes > 0, 'the app checks whether the server answered at all', `${probes} probe(s)`)
    ok(
      /refused its reply/i.test(text),
      'and says the reply was refused rather than blaming the connection',
      (/Reached the server[^.]*\./.exec(text) ?? ['(not shown)'])[0].slice(0, 90),
    )
    ok(
      /ALLOWED_ORIGINS/.test(text),
      'naming the setting to change, since the person reading this just deployed',
    )
    /*
      The point of the whole exercise. "Try again in a moment" on a
      configuration mismatch is not merely unhelpful, it is advice that cannot
      work, and it is what sent me looking at the network for an afternoon.
    */
    ok(
      !/Try again in a moment/i.test(text),
      'and does not tell anyone to retry something retrying cannot fix',
    )
  }

  /* ===== and a genuinely dead link still says so ======================== */
  //
  // The control. Without it, the change above would pass just as well if every
  // network failure had been relabelled as a CORS problem — which would be the
  // same bug pointing the other way.
  {
    const { text, probes } = await signInWith({ probeAnswers: false })
    ok(probes > 0, 'the probe runs here too', `${probes} probe(s)`)
    ok(
      /Try again in a moment/i.test(text),
      'an unreachable server still reads as unreachable, and still worth retrying',
      (/Couldn[^.]*\./.exec(text) ?? ['(not shown)'])[0].slice(0, 60),
    )
    ok(
      !/refused its reply/i.test(text) && !/ALLOWED_ORIGINS/.test(text),
      'and is not blamed on configuration',
    )
  }
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== a refused reply and a dead link no longer share one sentence ===')
