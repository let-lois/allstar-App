import { existsSync } from 'node:fs'

/**
 * Finding Chromium, wherever this happens to be running.
 *
 * Every browser gate used to name one absolute path: the one this project's dev
 * container installs. That path is correct here and nowhere else, so the entire
 * browser suite was unrunnable on a CI runner — which is a large part of why
 * there was no CI, and why thirty-five gates only ever ran when somebody
 * remembered to run them.
 *
 * Resolution order, most specific first:
 *
 *   CHROMIUM_PATH        an explicit override, for an environment neither of
 *                        the other two answers suits
 *   the container's copy  checked for existence rather than assumed, so this
 *                        file keeps working here without special-casing
 *   Playwright's own     whatever `npx playwright install chromium` put down,
 *                        found by the library rather than guessed at
 *
 * The last case returns `undefined` on purpose. Playwright treats an undefined
 * `executablePath` as "you pick", which is exactly right — inventing a path and
 * having it be wrong produces a launch failure that reads like a broken test
 * rather than a missing browser.
 */

const CONTAINER = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  if (existsSync(CONTAINER)) return CONTAINER
  return undefined
}
