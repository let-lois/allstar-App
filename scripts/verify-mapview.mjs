import { CLOSE_ZOOM, DEFAULT_VIEW, cleanView, initialMapView, shouldJumpToFix } from '../src/lib/map-view.ts'
import { bindChunks } from '../api/src/d1.ts'
import { followUpState } from '../src/lib/followups.ts'
import { appointmentsByLead, byNextAppointment, matchesAppointment } from '../src/lib/appointments.ts'

/**
 * The rules behind three fixes, without a browser.
 *
 *   Where the map opens: the lead just visited, then the saved view, then the
 *   rep's location, then today's route, then the first lead, and the fixed
 *   default last — never the first lead while anything better is known.
 *   D1's 100-parameter ceiling: every chunk binds at most 100.
 *   Follow-ups by calendar day; appointments by lead.
 */
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}

const PHX = { lat: 33.4484, lng: -112.074 }
const HERE = { lat: 30.51, lng: -97.67 }
const SAVED = { lat: 34.98, lng: -81.65, zoom: 15, heading: 30, tilt: 45 }

let r = initialMapView({ saved: SAVED, position: HERE, firstLead: PHX })
ok(r.source === 'saved' && r.view.lat === SAVED.lat && r.view.heading === 30 && r.view.tilt === 45, 'a saved view wins over location and the first lead, heading and tilt included', JSON.stringify(r))
r = initialMapView({ position: HERE, firstLead: PHX })
ok(r.source === 'device' && r.view.lat === HERE.lat, 'with nothing saved, the rep’s location', r.source)
r = initialMapView({ routeStop: HERE, firstLead: PHX })
ok(r.source === 'route', 'then today’s first stop', r.source)
r = initialMapView({ firstLead: PHX })
ok(r.source === 'first-lead', 'the first lead only when nothing better is known', r.source)
r = initialMapView({})
ok(r.source === 'default' && r.view.lat === DEFAULT_VIEW.lat, 'and the fixed default last', r.source)
r = initialMapView({ lead: HERE, saved: SAVED })
ok(r.source === 'lead' && r.view.lat === HERE.lat && r.view.zoom >= CLOSE_ZOOM, 'back from a visit: that lead, close up', JSON.stringify(r.view))
ok(cleanView({ lat: 0, lng: 0, zoom: 10 }) === null && cleanView({ lat: 'x', lng: 1, zoom: 3 }) === null && cleanView({ lat: 95, lng: 1, zoom: 3 }) === null, 'a junk or unset saved view is ignored')
ok(shouldJumpToFix('default', false) && shouldJumpToFix('first-lead', false), 'a guessed opening moves to the rep when their location arrives')
ok(!shouldJumpToFix('saved', false) && !shouldJumpToFix('lead', false) && !shouldJumpToFix('default', true), 'a chosen view, or one the rep has moved, does not')

for (const fixed of [0, 1, 2, 3, 4]) {
  const chunks = bindChunks(Array.from({ length: 1000 }, (_, i) => i), fixed)
  const worst = Math.max(...chunks.map((c) => c.length + fixed))
  ok(worst <= 100 && chunks.flat().length === 1000, `bindChunks with ${fixed} shared parameter(s) never binds more than 100 and loses nothing`, worst)
}
ok(bindChunks(Array.from({ length: 10 }, (_, i) => i), 3, 4).every((c) => c.length * 4 + 3 <= 100), 'several parameters per item are counted too')

const tz = 'America/New_York'
const noon = Date.parse('2026-10-02T16:00:00Z') // 12:00 in New York
ok(followUpState(Date.parse('2026-10-02T21:00:00Z'), tz, noon) === 'today', 'due at 5pm today is due today, not overdue at noon')
ok(followUpState(Date.parse('2026-10-02T13:00:00Z'), tz, noon) === 'today', 'due at 9am today is still today at noon, not overdue')
ok(followUpState(Date.parse('2026-10-01T21:00:00Z'), tz, noon) === 'overdue', 'yesterday is overdue')
ok(followUpState(Date.parse('2026-10-03T14:00:00Z'), tz, noon) === 'upcoming', 'tomorrow is upcoming')

const now = Date.now()
const by = appointmentsByLead([
  { id: 'a', propertyId: 'p1', repId: 'r', startsAt: now + 3_600_000, durationMin: 45, title: 'x' },
  { id: 'b', propertyId: 'p1', repId: 'r', startsAt: now + 60_000, durationMin: 45, title: 'x' },
  { id: 'c', propertyId: 'p2', repId: 'r', startsAt: now - 60_000, durationMin: 45, title: 'x' },
], now)
ok(by.get('p1')?.next?.id === 'b' && by.get('p1')?.count === 2, 'a lead’s next appointment is its soonest upcoming one')
ok(!by.get('p2')?.next && by.get('p2')?.last?.id === 'c', 'a past appointment is not "upcoming"')
ok(matchesAppointment(by.get('p1'), 'upcoming') && !matchesAppointment(by.get('p2'), 'upcoming') && matchesAppointment(by.get('p2'), 'has') && matchesAppointment(undefined, 'none'), 'the filter agrees')
ok(byNextAppointment(by.get('p1'), by.get('p2')) < 0 && byNextAppointment(undefined, by.get('p1')) > 0, 'sorting puts the soonest first and none last')

if (fails.length) {
  console.log(`\n${fails.length} failure(s)`)
  process.exit(1)
}
console.log('\n=== map view / limits / follow-ups OK ===')
