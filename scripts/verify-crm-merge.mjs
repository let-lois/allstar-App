import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What an inbound GoHighLevel change may and may not touch.
 *
 * The conflict rule is that Allstar wins absolutely: on a lead both systems
 * know about, our copy is authoritative and nothing inbound is applied. The one
 * carve-out is that winning requires something to win with — where Allstar holds
 * no value at all there is no disagreement, so a blank is filled and a value is
 * never replaced.
 *
 * Tested as a pure function, exhaustively, because this is the half of a sync
 * where a mistake does not fail loudly. A webhook that rejects a payload gets
 * noticed within the hour. A merge that overwrites a customer's corrected phone
 * number with an old one looks exactly like the system working, and is found
 * weeks later by the person who made the correction twice.
 *
 * Both directions matter equally here and the second is the one worth the effort:
 * that a blank *is* filled, and that a value is *not*. A function that filled
 * nothing at all would pass every assertion about not overwriting.
 */

const out = join(mkdtempSync(join(tmpdir(), 'merge-')), 'merge.mjs')
await build({
  entryPoints: ['api/src/crm-merge.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
})
const { planInboundFill, isNoop, FILLABLE_PROPERTY_FIELDS } = await import(out)

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const CONTACT = { id: 'c1', name: 'Marguerite Adeyemi', phone: '512-555-0148', email: 'm@example.com' }
const lead = (over = {}) => ({
  propertyId: 'p1',
  city: 'Round Rock',
  state: 'TX',
  zip: '78664',
  contact: { ...CONTACT },
  ...over,
})

/* --- 1. a value is never replaced ----------------------------------------- */
//
// The whole point of the rule. Everything inbound differs from everything local.
{
  const plan = planInboundFill(lead(), {
    firstName: 'Someone', lastName: 'Else',
    phone: '999-999-9999', email: 'wrong@example.com',
    city: 'Austin', state: 'CA', postalCode: '00000',
  })
  ok(isNoop(plan), 'a lead with every field set takes nothing from GoHighLevel', JSON.stringify(plan.filled))
  ok(Object.keys(plan.property).length === 0, 'no property field is touched')
  ok(plan.contact.action === 'none', 'and the contact is left alone', plan.contact.action)
}

/* --- 2. a blank IS filled ------------------------------------------------- */
//
// The other direction, and the one that stops this file passing on a function
// that does nothing at all.
{
  const plan = planInboundFill(lead({ zip: null, contact: { ...CONTACT, phone: null } }), {
    phone: '512-555-0177',
    postalCode: '78681',
  })
  ok(plan.property.zip === '78681', 'a blank ZIP is filled', plan.property.zip)
  ok(plan.contact.action === 'update' && plan.contact.phone === '512-555-0177', 'a blank phone is filled')
  ok(plan.contact.id === 'c1', 'against the contact that already exists')
  ok(plan.filled.includes('zip') && plan.filled.includes('phone'), 'and both are named in the plan', plan.filled.join(', '))
}

/* --- 3. blank means absent, in every shape it arrives in ----------------- */
{
  for (const empty of [null, undefined, '', '   ']) {
    const plan = planInboundFill(lead({ contact: { ...CONTACT, email: empty } }), { email: 'new@example.com' })
    const filled = plan.contact.action === 'update' && plan.contact.email === 'new@example.com'
    if (!filled) fails.push(`an email of ${JSON.stringify(empty)} should count as blank`)
  }
  ok(
    !fails.some((f) => f.includes('should count as blank')),
    'null, undefined, empty and whitespace all count as blank',
  )
}

/* --- 4. whitespace inbound is not a value ------------------------------- */
//
// A field of spaces arriving from their side must not overwrite a blank with a
// blank and then be reported as filled — that is an audit entry saying a lead
// changed when it did not.
{
  const plan = planInboundFill(lead({ zip: null }), { postalCode: '   ' })
  ok(isNoop(plan), 'whitespace arriving from GoHighLevel fills nothing', JSON.stringify(plan.filled))
}

/* --- 5. mixed: one blank, one set --------------------------------------- */
//
// The realistic case, and the one a careless implementation gets wrong by
// applying the whole payload once any part of it qualifies.
{
  const plan = planInboundFill(lead({ contact: { ...CONTACT, phone: null } }), {
    phone: '512-555-0177',
    email: 'wrong@example.com',
  })
  ok(plan.contact.action === 'update', 'the blank field is updated')
  ok(plan.contact.phone === '512-555-0177', 'with the incoming phone')
  ok(plan.contact.email === undefined, 'and the email that was already set is not carried along')
  ok(plan.filled.length === 1 && plan.filled[0] === 'phone', 'only the phone is reported as filled', plan.filled.join(','))
}

/* --- 6. a lead with no contact at all ----------------------------------- */
//
// The case that pays for this whole file. A lead with no phone and no email
// cannot be pushed — GoHighLevel matches an upsert on one of those — so an
// address-only row is unsendable until something arrives.
{
  const plan = planInboundFill(lead({ contact: null }), {
    firstName: 'Halvard', lastName: 'Restrepo', phone: '512-555-0177',
  })
  ok(plan.contact.action === 'create', 'a lead with no contact gains one')
  ok(plan.contact.name === 'Halvard Restrepo', 'with the name assembled from their fields', plan.contact.name)
  ok(plan.contact.phone === '512-555-0177', 'and the phone that makes it sendable')
}
{
  const plan = planInboundFill(lead({ contact: null }), { name: 'Wilhelmina Ackerbridge' })
  ok(
    plan.contact.action === 'none',
    'but a name with no phone or email creates nothing — it would look like a gain and change nothing',
  )
  ok(isNoop(plan), 'and nothing is reported as filled')
}
{
  const plan = planInboundFill(lead({ contact: null }), { email: 'only@example.com' })
  ok(plan.contact.action === 'create' && plan.contact.name === 'Unknown', 'an email with no name still creates a reachable contact', plan.contact.name)
}

/* --- 7. lead state is not reachable from here --------------------------- */
//
// Not a runtime check — the plan has no field to express it in, which is the
// stronger guarantee. Asserted anyway so that widening the plan carelessly
// trips something.
{
  const plan = planInboundFill(lead({ city: null, zip: null }), {
    city: 'Austin', postalCode: '78681',
    // Everything Allstar owns outright, offered up by the other side.
    status: 'won', last_outcome: 'sold', dnc: false, lat: 1, lng: 2, address1: '9 Other St',
  })
  const keys = Object.keys(plan.property)
  ok(
    keys.every((k) => FILLABLE_PROPERTY_FIELDS.includes(k)),
    'a plan can only ever name city, state or zip',
    keys.join(', '),
  )
  ok(!('status' in plan), 'there is nowhere in a plan to put a status')
  ok(!('lat' in plan.property) && !('lng' in plan.property), 'nor coordinates — those are ours to geocode')
  ok(!('address1' in plan.property), 'nor the address, which is the identity of the lead')
  ok(plan.filled.length === 2, 'and only the two genuine blanks were filled', plan.filled.join(', '))
}

/* --- 8. a Do Not Contact lead is no different -------------------------- */
//
// It cannot be reversed from here because status is unreachable — but a DNC lead
// is still a lead, and filling in a missing ZIP on one is not contacting anybody.
{
  const plan = planInboundFill(lead({ zip: null }), { postalCode: '78681', status: 'active' })
  ok(plan.property.zip === '78681', 'a blank on a Do Not Contact lead is still filled')
  ok(!('status' in plan), 'and nothing inbound can touch the flag itself')
}

/* --- 9. nothing inbound at all ----------------------------------------- */
{
  ok(isNoop(planInboundFill(lead({ contact: null, city: null, state: null, zip: null }), {})),
    'an empty inbound payload changes nothing, even on an empty lead')
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== inbound changes fill blanks and never overwrite ===')
