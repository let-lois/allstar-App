import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { invitePage } from '../api/src/pages.ts'
import { LOGO_PNG_BASE64 } from '../api/src/brand-logo.ts'

/**
 * The invitation page looks like Login, measured rather than eyeballed.
 *
 * The page an invited person sets their password on is served by the API
 * Worker, not the app, so it cannot share Login's components — it copies their
 * values instead. This gate opens Login (from the preview build) and every
 * state of the invitation page side by side, in both themes, and compares the
 * computed styles of the parts that make them one experience: the ground, the
 * wordmark tile, the column, the card, labels, fields, the Show button and the
 * primary button. A change to either side that the other does not follow fails
 * here.
 *
 * It also holds the invitation behaviour the restyle must not touch: the form
 * still posts to /invite/TOKEN with `password` and `confirm`, both required at
 * 10 characters, the email read-only; the reset wording; the done, expired and
 * already-active states; and no horizontal scroll from 320px to desktop.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}

ok(
  readFileSync(new URL('../src/assets/logo.png', import.meta.url)).toString('base64') === LOGO_PNG_BASE64,
  'the invitation page embeds exactly the wordmark Login shows',
)

const invite = { email: 'dana.whitlock@allstar.test', name: 'Dana Whitlock', clientName: 'All Star Home Solutions' }
const APP = 'https://app.allstar.test'
const html = async (r) => r.text()
const PAGES = {
  form: await html(invitePage({ token: 'tok_abc', invite, appUrl: APP })),
  error: await html(invitePage({ token: 'tok_abc', invite, appUrl: APP, error: 'The two passwords do not match.' })),
  reset: await html(invitePage({ token: 'tok_abc', invite: { ...invite, kind: 'reset' }, appUrl: APP })),
  done: await html(invitePage({ token: 'tok_abc', appUrl: APP, done: true })),
  doneReset: await html(invitePage({ token: 'tok_abc', appUrl: APP, done: true, kind: 'reset' })),
  expired: await html(invitePage({ token: 'tok_abc', appUrl: APP })),
  active: await html(invitePage({ token: 'tok_abc', invite: { ...invite, alreadyActive: true }, appUrl: APP })),
}

/* --- what the invitation still does ------------------------------------- */
{
  const f = PAGES.form
  ok(/<form method="POST" action="\/invite\/tok_abc"/.test(f), 'the form still posts to /invite/TOKEN')
  ok(/name="password"[^>]*required[^>]*minlength="10"/.test(f) && /name="confirm"[^>]*required[^>]*minlength="10"/.test(f), 'password and confirm are both required, at least 10 characters')
  ok(/value="dana\.whitlock@allstar\.test" readonly/.test(f), 'the invited email is shown, read-only')
  ok(/Create your account/.test(f) && /Welcome, Dana\./.test(f) && /All Star Home Solutions account/.test(f), 'Create your account, with the person and the company')
  ok(/>Create account<\/button>/.test(f), 'the button says Create account')
  ok(/The two passwords do not match\./.test(PAGES.error) && /role="alert"/.test(PAGES.error), 'a server error is shown under the fields, as an alert')
  ok(/Reset your password/.test(PAGES.reset) && />Change password<\/button>/.test(PAGES.reset) && /data-kind="reset"/.test(PAGES.reset), 'a reset link keeps its own wording')
  ok(/You're in/.test(PAGES.done) && /data-state="done"/.test(PAGES.done) && PAGES.done.includes(`href="${APP}"`), 'done: You\'re in, with the way to sign in')
  ok(/Password changed/.test(PAGES.doneReset) && /old one no longer works/.test(PAGES.doneReset), 'done after a reset says the password changed')
  ok(/This link has expired/.test(PAGES.expired) && !/<form/.test(PAGES.expired), 'an expired link has no form')
  ok(/already set up/.test(PAGES.active) && !/<form/.test(PAGES.active), 'an already-active account has no form')
  ok(!/\ssrc="https?:/.test(f) && !/<link\b/.test(f), 'nothing is loaded from another host: the logo is embedded and the styles inline')
}

/* --- side by side with Login --------------------------------------------- */
const K = ['backgroundColor', 'color', 'borderRadius', 'borderTopWidth', 'borderTopColor', 'boxShadow', 'paddingTop', 'paddingLeft', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'textTransform']
/*
  Two kinds of difference that are not differences: Tailwind's ring utilities
  leave zero-size transparent shadows in front of the real ones, and the
  invitation page's autofocused field is caught mid focus-ring transition. The
  first is stripped; the second is settled by blurring before measuring.
*/
const measure = async (page) => {
  for (let i = 0; i < 2; i++) {
    await page.waitForTimeout(150)
    await page.evaluate(() => document.activeElement?.blur?.())
  }
  await page.waitForTimeout(250)
  return page.evaluate((K) => {
    const pick = (el, keys = K) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const o = {}
      for (const k of keys) o[k] = k === 'boxShadow' ? cs[k].replace(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?/g, '') : cs[k]
      const b = el.getBoundingClientRect()
      o.width = Math.round(b.width)
      o.height = Math.round(b.height)
      o.left = Math.round(b.left)
      return o
    }
    const ground = document.querySelector('.app-shell') ?? document.body
    return {
      ground: pick(ground, ['backgroundColor', 'color', 'fontFamily', 'fontSize', 'letterSpacing']),
      wordmark: pick(document.querySelector('.wordmark')),
      logo: pick(document.querySelector('.wordmark img'), ['width']),
      h1: pick(document.querySelector('h1'), ['color', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontFamily']),
      card: pick(document.querySelector('.card')),
      label: pick(document.querySelector('.card label span'), ['color', 'fontSize', 'fontWeight', 'lineHeight']),
      input: pick(document.querySelector('.card input[type="password"]')),
      reveal: pick(document.querySelector('.card button[aria-pressed]')),
      primary: pick(document.querySelector('.card button[type="submit"]')),
      links: pick(document.querySelector('a[href*="privacy"]'), ['color', 'fontSize', 'fontWeight', 'height']),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  }, K)
}

const SAME = {
  ground: ['backgroundColor', 'color', 'fontFamily', 'fontSize'],
  wordmark: ['backgroundColor', 'borderRadius', 'boxShadow', 'paddingTop', 'paddingLeft', 'width', 'height'],
  logo: ['width'],
  h1: ['color', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontFamily'],
  card: ['backgroundColor', 'borderRadius', 'borderTopWidth', 'borderTopColor', 'boxShadow', 'paddingTop', 'paddingLeft', 'width', 'left'],
  label: ['color', 'fontSize', 'fontWeight', 'lineHeight'],
  input: ['backgroundColor', 'color', 'borderRadius', 'boxShadow', 'paddingLeft', 'fontSize', 'height', 'width'],
  reveal: ['backgroundColor', 'color', 'borderRadius', 'boxShadow', 'fontSize', 'fontWeight', 'textTransform', 'letterSpacing', 'width', 'height'],
  primary: ['backgroundColor', 'color', 'borderRadius', 'boxShadow', 'fontSize', 'fontWeight', 'height', 'width'],
  links: ['color', 'fontSize', 'fontWeight', 'height'],
}

const browser = await chromium.launch({ executablePath: chromiumPath() })
try {
  for (const colorScheme of ['dark', 'light']) {
    for (const [device, width, height] of [['iPhone 14', 390, 844], ['desktop', 1366, 860]]) {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, serviceWorkers: 'block' })
      const login = await ctx.newPage()
      await login.goto(BASE, { waitUntil: 'networkidle' })
      const a = await measure(login)
      const inv = await ctx.newPage()
      await inv.setContent(PAGES.form, { waitUntil: 'load' })
      const b = await measure(inv)
      const diffs = []
      for (const [part, keys] of Object.entries(SAME)) {
        for (const k of keys) {
          if (a[part]?.[k] !== b[part]?.[k]) diffs.push(`${part}.${k}: login ${a[part]?.[k]} / invite ${b[part]?.[k]}`)
        }
      }
      ok(diffs.length === 0, `${colorScheme}, ${device}: the invitation page measures the same as Login`, diffs.join('; ') || undefined)
      await ctx.close()
    }
  }

  /* --- every width, every state: nothing scrolls sideways ------------------ */
  for (const width of [320, 375, 390, 430, 768, 1024, 1366]) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 740 : 900 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const bad = []
    for (const [name, h] of Object.entries(PAGES)) {
      await page.setContent(h, { waitUntil: 'load' })
      const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      if (o > 0) bad.push(`${name} +${o}px`)
    }
    ok(bad.length === 0, `${width}px: no state of the page scrolls sideways`, bad.join(', ') || undefined)
    await ctx.close()
  }

  /* --- a short phone with the keyboard up: the form scrolls from its top ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 420 }, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    await page.setContent(PAGES.error, { waitUntil: 'load' })
    const top = await page.evaluate(() => document.querySelector('.wordmark').getBoundingClientRect().top)
    ok(top >= 0, 'on a short screen the top of the page is still reachable', top)
    await page.locator('button[type="submit"]').scrollIntoViewIfNeeded()
    ok(await page.locator('button[type="submit"]').isVisible(), 'and the button can be scrolled to')

    /* Show / Hide, as on Login */
    await page.setContent(PAGES.form, { waitUntil: 'load' })
    const pw = page.locator('input[name="password"]')
    const show = page.locator('input[name="password"] + button')
    await pw.fill('abcdefghij')
    await show.click()
    ok((await pw.getAttribute('type')) === 'text' && (await show.innerText()).trim().toLowerCase() === 'hide', 'Show reveals the password and becomes Hide')
    await show.click()
    ok((await pw.getAttribute('type')) === 'password', 'and Hide covers it again')
    ok((await pw.inputValue()) === 'abcdefghij', 'without losing what was typed')
    ok((await page.locator('input[name="confirm"]').getAttribute('type')) === 'password', 'each field has its own Show')

    /* The browser still refuses a short password before anything is sent. */
    let posted = 0
    await page.route('**/invite/**', (r) => { posted++; return r.fulfill({ status: 200, body: 'ok' }) })
    await pw.fill('short')
    await page.locator('input[name="confirm"]').fill('short')
    await page.locator('button[type="submit"]').click()
    await page.waitForTimeout(300)
    ok(posted === 0, 'a password under 10 characters is stopped before it is sent')
    await ctx.close()
  }
} finally {
  await browser.close()
}

if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\nall passed')
