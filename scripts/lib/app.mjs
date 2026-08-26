/**
 * Waiting for a screen, and saying what went wrong when it never arrives.
 *
 * `page.getByRole(...).click()` already waits, so the naive version of this is
 * unnecessary. What it does not do is *explain*: a Playwright timeout says
 *
 *     locator.click: Timeout 30000ms exceeded.
 *     - waiting for getByRole('button', { name: /Start visit/ })
 *
 * which tells you a button was missing and nothing whatsoever about why. That
 * is a bad message on a laptop and a much worse one on a CI runner you cannot
 * open a browser on — two gates failed exactly this way on the first CI run and
 * the log could not distinguish "the app never booted" from "the property is
 * not in the store" from "an overlay is in the way".
 *
 * So this waits and, on failure, reports the URL and what the screen actually
 * says. The screen's own words are usually the whole diagnosis: "This property
 * isn't on this device." is a different bug from a blank page.
 */

/**
 * @param {import('playwright').Page} page
 * @param {RegExp|string} name  accessible name of the button
 * @param {{ timeout?: number, why?: string }} [opts]
 */
export async function button(page, name, opts = {}) {
  // Shorter than Playwright's 30s default on purpose: when this fails it is
  // going to fail, and a shard should not spend half a minute per occurrence
  // discovering that.
  const timeout = opts.timeout ?? 15_000
  const target = page.getByRole('button', { name }).first()
  try {
    await target.waitFor({ state: 'visible', timeout })
  } catch {
    throw new Error(await diagnose(page, `button ${name}`, opts.why))
  }
  return target
}

/** What the page was showing when it did not have what we wanted. */
export async function diagnose(page, wanted, why) {
  let body = '(could not read the page)'
  try {
    body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim()
  } catch {
    /* the page may be gone entirely */
  }
  return [
    `${wanted} never appeared${why ? ` — ${why}` : ''}`,
    `  url:    ${page.url()}`,
    `  screen: ${body.slice(0, 400) || '(empty)'}`,
  ].join('\n')
}
