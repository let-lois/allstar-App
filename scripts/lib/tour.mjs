/**
 * Dismiss the first-run tour, the way a person does.
 *
 * Every gate signs in on a fresh browser context, which is by definition a first
 * run — so the tour opens over Today and swallows taps, exactly as designed, and
 * exactly as it would for a real rep on their first morning.
 *
 * The gates could have been spared this by teaching the app to recognise
 * automation, which would mean the thing being tested is not the thing that
 * ships. Skipping it here is what the person it interrupts does, and it costs
 * one line per gate.
 */
export async function dismissTour(page, timeout = 3000) {
  const card = page.locator('[data-tour-card]')
  try {
    await card.first().waitFor({ state: 'visible', timeout })
  } catch {
    // It legitimately does not appear on screens with none of its anchors, and
    // never appears twice on a device that has already seen it.
    return false
  }
  await page.locator('[data-tour-skip]').click()
  await page.waitForTimeout(350)
  return true
}
