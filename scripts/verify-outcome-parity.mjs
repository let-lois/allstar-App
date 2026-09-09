import { OUTCOMES, OUTCOME_TO_STATUS as clientMap, STATUS_LABEL } from '../src/data/outcomes.ts'
import { OUTCOME_TO_STATUS as serverMap } from '../api/src/mutations.ts'

/**
 * Two copies of "what an outcome does to a lead", kept honest.
 *
 * `src/data/outcomes.ts` and `api/src/mutations.ts` each hold the mapping from
 * the outcome a rep taps to the status the lead lands on, and the duplication is
 * deliberate for the same reason as `day.ts` and `pointInPolygon`: the phone has
 * to answer it offline with no Worker, and the Worker has to answer it with no
 * browser. The same arrangement, and this is its parity gate — which it did not
 * have until a status was added and both copies needed editing at once.
 *
 * The consequence of drift is quiet and unpleasant. A rep taps Follow Up, their
 * phone paints the pin one colour immediately, the mutation reaches the Worker,
 * and the Worker writes a different status. Nothing errors. The lead simply
 * changes colour on the next refresh, and the rep is left believing the app
 * threw their answer away — while reporting counts something they never chose.
 *
 * Two directions, because either alone passes on a bad state: every outcome the
 * app offers must appear in both maps, and neither map may contain an outcome
 * the app does not offer — a stale entry left behind by a rename is how one side
 * keeps silently applying a rule nobody can see in the UI.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const codes = OUTCOMES.map((o) => o.code)
ok(codes.length > 0, 'the app offers outcomes to compare', `${codes.length} outcomes`)

/* --- every outcome is mapped, the same way, on both sides ---------------- */
/*
  `undefined` is a real answer here — "this outcome does not move the lead" is
  what No Answer means — so a missing key and a key set to undefined must not
  compare equal. They also print identically, which made the first failure this
  gate produced unreadable: hence `show`, which says "absent" out loud.
*/
const show = (map, code) => (code in map ? String(map[code]) : 'absent')

for (const code of codes) {
  ok(
    code in clientMap && code in serverMap && clientMap[code] === serverMap[code],
    `${code} maps the same on the phone and on the server`,
    `phone=${show(clientMap, code)} server=${show(serverMap, code)}`,
  )
}

/* --- and neither side carries an outcome the app has stopped offering ---- */
for (const [side, map] of [['the phone', clientMap], ['the server', serverMap]]) {
  const stale = Object.keys(map).filter((k) => !codes.includes(k))
  ok(stale.length === 0, `${side} maps no outcome the app does not offer`, stale.join(', ') || 'none')
}

/* --- a status that nothing can produce is worth knowing about ------------ */
//
// Not a failure. `contacted` is deliberately reachable only from the office and
// from GoHighLevel now that Follow-up exists, and `lost`/`dnc` are terminal. But
// a status no path can reach *and* nobody meant to orphan is a dead branch in
// the funnel, so the list is printed rather than asserted.
{
  const produced = new Set(Object.values(clientMap).filter(Boolean))
  const orphans = Object.keys(STATUS_LABEL).filter((s) => !produced.has(s))
  console.log(`\nstatuses no outcome produces (office- or CRM-set only): ${orphans.join(', ')}`)
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} parity check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== the phone and the server agree on what an outcome does ===')
