import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { chromiumPath } from './lib/browser.mjs'
import { diagnose } from './lib/app.mjs'

/**
 * The app must always finish booting.
 *
 * #40 was two gates failing on a machine nobody could log into, with a timeout
 * for a diagnosis. The cause was not the gates: `boot()` awaited two pieces of
 * sync bookkeeping — read a timestamp, count the outbox — *before* reading the
 * cache that every screen renders from. Nothing on screen wanted those counts,
 * but every pixel waited on them, so one slow IndexedDB read meant `ready`
 * never flipped and the app sat on "Loading your territory…" indefinitely. No
 * error, no timeout, no self-heal: the code that would have healed it was
 * parked behind the same await.
 *
 * Two things are checked here, because either one alone can be true while the
 * app is still broken.
 *
 *   1. Structure — first paint does not depend on sync bookkeeping. Cheap, and
 *      it names the regression precisely if someone reorders `boot()` again.
 *   2. Behaviour — an IndexedDB that never opens still produces a usable app.
 *      This is the failure that cannot be reasoned about from source: a blocked
 *      open does not throw, it waits, and every read in the app is behind it.
 *
 * Both are written to fail loudly when what they measure is missing. A check
 * that quietly finds nothing to look at is worse than no check, and this repo
 * has been bitten by that more than once.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

/* ========== 1. first paint does not wait on sync bookkeeping ============= */
{
  const src = readFileSync(new URL('../src/store/useAppStore.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('async boot()'))
  if (!body.startsWith('async boot()')) throw new Error('boot() not found in useAppStore.ts')
  const end = body.indexOf('\n  },')
  if (end < 0) throw new Error('could not find the end of boot() — this check is measuring nothing')
  /*
    Comments are stripped before anything is measured.

    The first version of this check did not, and reported the ordering as broken
    on a `boot()` that was correct — the word `initSync` appears in a comment at
    the top of the function explaining why the session is read first, and
    `indexOf` found the sentence rather than the call. A gate that reads prose
    is not measuring the program; it would have been just as happy to pass on a
    comment that said the right thing above code that did the wrong one.
  */
  const boot = body
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')

  // Every marker must exist. A renamed function has to break this gate rather
  // than silently turn its assertions into vacuous truths.
  for (const marker of ['loadLocal', 'initSync', 'initPhotoSync', 'loadSession']) {
    if (!boot.includes(marker)) throw new Error(`boot() no longer mentions ${marker} — update this gate`)
  }

  /*
    Not awaited is the whole assertion.

    An earlier draft checked that `loadLocal` appeared *before* these two in the
    file, which is the wrong invariant twice over: source position says nothing
    about blocking once the `await` is gone, and it actively pushed the calls
    below the signed-out early return, where they would never run at all.
    Nothing can be parked behind a call that is not awaited, so this is both
    necessary and sufficient.
  */
  ok(!/await\s+initSync\(\)/.test(boot), 'initSync() is not awaited into first paint')
  ok(!/await\s+initPhotoSync\(\)/.test(boot), 'initPhotoSync() is not awaited into first paint')

  /*
    And they must run on every path. `boot` is the only caller, and the
    signed-out branch returns early — so a rep who signs in from a cold start
    would otherwise spend that whole page load with no drain listeners at all.
  */
  const earlyReturn = boot.indexOf('return')
  if (earlyReturn < 0) throw new Error('boot() no longer has an early return — update this gate')
  ok(
    boot.indexOf('initSync') < earlyReturn,
    'the outbox is counted on every path, including signed out',
  )
  ok(
    boot.indexOf('initPhotoSync') < earlyReturn,
    'the photo queue is counted on every path, including signed out',
  )
  ok(
    boot.indexOf('loadSession') < boot.indexOf('initSync'),
    'the session is still read before a drain can start — that ordering is load-bearing',
  )
}

/* ========== 2. a database that never opens still boots the app =========== */
const browser = await chromium.launch({ executablePath: chromiumPath() })
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()

  /*
    A blocked open, reproduced honestly.

    `indexedDB.open` returns a request that simply never fires when another
    connection holds an older version of the database — it does not error, and
    there is no event to wait for. Returning a request that never settles is
    exactly that, and it is the one condition the app used to hang on forever.
  */
  await page.addInitScript(() => {
    /*
      A real IDBRequest that never fires, not a stand-in for one.

      The first version of this returned a plain object with a no-op
      `addEventListener`, which looked like a request that never settles and was
      nothing of the sort: `idb` promisifies a request only after an
      `instanceof IDBRequest` check, so a plain object fell straight through as
      a resolved value and the app carried on. The check passed with the bug
      deliberately put back — it was measuring nothing.

      Proxying a genuine request keeps `instanceof` true while swallowing the
      listeners `idb` needs to ever resolve. That is what a blocked open looks
      like from the app's side: a live request, no error, no completion.
    */
    // eslint-disable-next-line no-undef
    const realOpen = indexedDB.open.bind(indexedDB)
    // eslint-disable-next-line no-undef
    indexedDB.open = (...args) => {
      const req = realOpen(...args)
      return new Proxy(req, {
        get(target, key) {
          if (key === 'addEventListener') return () => {}
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
        // `onsuccess = fn` is the other way in, and idb uses it for upgrades.
        set() {
          return true
        },
      })
    }
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // Generous: the app's own budget is 10s, so this only fails if the wait is
  // genuinely unbounded rather than merely long.
  const signIn = page.getByRole('button', { name: /^Sign in$/ })
  let booted = true
  try {
    await signIn.waitFor({ state: 'visible', timeout: 20_000 })
  } catch {
    booted = false
    console.log(await diagnose(page, 'the sign-in screen', 'IndexedDB never opened'))
  }
  ok(booted, 'a database that never opens still reaches a usable screen')

  if (booted) {
    // Not merely painted — usable. The memory fallback has to carry a real
    // session, or "it booted" means a rep staring at a form that cannot work.
    await page.route('**/api/**', (route) => route.abort('connectionrefused'))
    await page.getByRole('button', { name: /Try the demo/ }).click()
    await page.getByRole('button', { name: /Dana Whitfield/ }).click()
    await page.waitForTimeout(3000)
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    ok(
      !/Loading your territory/.test(text),
      'and does not strand the rep on the loading splash',
    )
  }

  await ctx.close()
}

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} boot check(s) failed`)
  process.exit(1)
}
console.log('\nthe app finishes booting, on disk or without it')
