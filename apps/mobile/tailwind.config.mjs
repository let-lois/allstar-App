/**
 * The web app's Tailwind theme, pointed at the web app's source.
 *
 * Deliberately the *same* config object — every token, breakpoint and plugin
 * comes from the root file rather than a copy. A second copy would drift, and
 * the first thing to drift would be a colour, which is exactly the class of
 * difference nobody notices until a rep says the app looks wrong on their
 * phone but fine on the laptop.
 *
 * Only `content` differs, because the class names to scan live one directory up
 * from here. The paths are absolute, resolved from this file, so they work
 * whichever directory Metro is invoked from.
 */
import { fileURLToPath } from 'node:url'
import base from '../../tailwind.config.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))

export default {
  ...base,
  content: [`${repo}src/**/*.{ts,tsx}`, `${repo}packages/core/src/**/*.ts`],
}
