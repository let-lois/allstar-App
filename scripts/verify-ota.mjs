import { AWAY_MS, shouldApply, shouldCheck } from '../apps/mobile/src/lib/ota.ts'

/**
 * The shell's over-the-air rule: check at launch and on a return, apply at
 * launch or after a real absence, never in development or with updates off.
 * See apps/mobile/src/lib/ota.ts for why.
 */

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

ok(shouldCheck(true, false, { kind: 'launch' }), 'a launch checks for an update')
ok(shouldApply({ kind: 'launch' }), 'and applies one it finds straight away, before anything is typed')
ok(shouldCheck(true, false, { kind: 'foreground', awayMs: AWAY_MS }), 'a return after five minutes checks')
ok(shouldApply({ kind: 'foreground', awayMs: AWAY_MS }), 'and applies what it finds')
ok(shouldCheck(true, false, { kind: 'foreground', awayMs: 60_000 }), 'a return after a minute still downloads')
ok(!shouldApply({ kind: 'foreground', awayMs: 60_000 }), 'but does not reload the screen under a half-typed note')
ok(!shouldCheck(true, false, { kind: 'foreground', awayMs: 5_000 }), 'a glance away does not even check')
ok(!shouldCheck(false, false, { kind: 'launch' }), 'nothing happens when updates are off (a build with no channel)')
ok(!shouldCheck(true, true, { kind: 'launch' }), 'or in development, where Metro serves the code')

if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\n=== updates arrive on reopen, never mid-sentence ===')
