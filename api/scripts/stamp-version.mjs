import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stamp the commit being deployed into the Worker, so a stale deployment says so.
 *
 * The failure this exists for happened: a build token belonging to somebody who
 * had left the organisation broke every Worker deploy for nine days. Cloudflare
 * Pages kept deploying, so the front end moved and the API did not, and the only
 * signal anywhere was a red checkmark next to a green one on each commit — which
 * reads like noise, and was read like noise. Nine days of merged work sat in
 * `main` while everyone believed it was live.
 *
 * Nothing in the app could have told anyone. A Worker has no idea what version it
 * is; it answers requests exactly as well as it did the day it was deployed. So
 * this writes `src/version.ts` at build time and `/api/health` reports it, and
 * the question "is production current" becomes one `curl` and a `git log` rather
 * than a belief.
 *
 *   node scripts/stamp-version.mjs           # writes src/version.ts
 *   node scripts/stamp-version.mjs --print    # says which sha it would use
 *
 * ## Why postinstall
 *
 * Cloudflare's build settings run `npm ci` and then `npx wrangler deploy` —
 * `npx` rather than `npm run`, so no npm script hook on `deploy` would ever
 * fire. `npm ci` does run `postinstall`, which lands before the bundle is built.
 * Hanging it there means this works with the build configuration as it already
 * is, and nobody has to remember a dashboard field.
 *
 * The cost of that choice is that this runs during every install anywhere, so it
 * must never be able to fail one. Every path below writes the file and exits
 * zero — a missing `git`, a tarball with no `.git`, an unreadable directory all
 * end in `commit: null`, which `/api/health` reports as "not stamped" rather
 * than pretending to know.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const OUT = resolve(api, 'src/version.ts')

const git = (...args) => {
  try {
    return execFileSync('git', args, {
      cwd: api,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/*
  Cloudflare's own value first. Workers Builds sets it, and it is the sha being
  deployed by definition — whereas `git rev-parse` in a build container depends
  on how the clone was made. On a laptop the env var is absent and git is right.
*/
const commit = process.env.WORKERS_CI_COMMIT_SHA?.trim() || git('rev-parse', 'HEAD') || null

/*
  Whether the tree had uncommitted changes when this was stamped.

  A hand-deploy from a dirty checkout produces a Worker whose sha is a lie —
  it names a commit that is not what is running. Reporting the sha without this
  would make that deployment indistinguishable from a clean one, which is the
  same class of quiet wrongness this whole file is about. Workers Builds always
  clones fresh, so it is only ever true for a deploy somebody did by hand.

  Tracked modifications only (`-uno`). Counting untracked files would make this
  true for anyone with a scratch file anywhere in the repo, and a flag that is
  always on is not a flag — it would be ignored within a week, which is worse
  than not having it. The gap that leaves: a *new* source file that is imported
  but never committed would be bundled without this noticing. That is rare, and
  the alternative is a signal nobody reads.
*/
const dirty = commit ? git('status', '--porcelain', '-uno').length > 0 : false

if (process.argv.includes('--print')) {
  console.log(commit ?? '')
  process.exit(0)
}

const body = `/*
 * GENERATED — do not edit, and do not commit. Git-ignored on purpose.
 *
 * Written by scripts/stamp-version.mjs on every install, which is how the
 * commit being deployed reaches /api/health. See that script for why a
 * generated file rather than a build variable.
 */
export const COMMIT: string | null = ${commit ? JSON.stringify(commit) : 'null'}
export const BUILT_AT = ${JSON.stringify(new Date().toISOString())}
export const DIRTY = ${dirty}
`

try {
  writeFileSync(OUT, body)
} catch (err) {
  /*
    Reported and survived. This runs inside `npm ci`, and a version stamp is not
    worth failing an install over — the Worker still deploys, and health reports
    an unstamped build, which is a smaller problem than a build that will not
    start.
  */
  console.warn(`[allstar] could not write src/version.ts (${String(err).slice(0, 120)})`)
}
