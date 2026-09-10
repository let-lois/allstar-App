/**
 * Driving the map's filter sheet from a gate.
 *
 * The map's filters used to be fourteen chips in a rail, so a gate could click
 * one by name and be done. They are now three chips and a button that opens a
 * sheet, which is better for a rep with a thumb and slightly more work for a
 * test — so the work lives here once rather than in each of the four gates that
 * needs it.
 *
 * The names inside the sheet are deliberately the names that were on the rail:
 * 'Today', 'Never knocked', 'Over 30 days ago', 'No answer', the nine statuses.
 * Nothing about what those gates assert has changed; only the two taps it takes
 * to reach the control.
 */

/** Open the sheet, tap the named options in order, and close it again. */
export async function withFilters(page, ...names) {
  await page.getByTestId('map-filters').click()
  await page.waitForTimeout(450)
  for (const name of names) {
    await page.getByRole('button', { name: new RegExp(`^${name}$`) }).click()
    await page.waitForTimeout(250)
  }
  // The primary button applies nothing — the choices are already live — it just
  // gets the sheet out of the way of whatever the gate is about to measure.
  await page.getByRole('button', { name: /^Show \d+ leads?$/ }).click()
  await page.waitForTimeout(550)
}

/** Back to everything: the one chip that clears every axis at once. */
export async function showAll(page) {
  await page.getByRole('button', { name: /^All$/ }).click()
  await page.waitForTimeout(550)
}
