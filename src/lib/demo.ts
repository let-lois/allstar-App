import { buildSeed, type SeedBundle } from '../data/seed'
import * as db from './db'
import { dayKey } from './format'
import type { StoreName } from './db'

/**
 * Demo data lifecycle.
 *
 * This is the only module besides data/seed.ts that knows the data is synthetic,
 * so removing the demo later is a two-file job.
 *
 * The problem it solves: the app is offline-first, so the seed is written to
 * IndexedDB once and then persists. Every seeded timestamp — today's route,
 * this afternoon's appointments, this morning's activity — is anchored to the
 * day it was generated. Reopen the demo tomorrow and the Today screen filters
 * all of it out as "not today", leaving empty sections. That fails in front of
 * a prospect, silently, with no error to explain it.
 *
 * So the seeded day is recorded, and the demo is regenerated whenever the day
 * rolls over. It always looks like today.
 */

const SEED_DAY_KEY = 'allstar.seedDay'

/** Stores owned by the demo seed and safe to replace wholesale. */
const SEEDED_STORES: StoreName[] = [
  'properties',
  'territories',
  'routes',
  'appointments',
  'tasks',
  'activity',
  'dailyStats',
]

/**
 * Stores holding work the *user* created during the demo. Cleared alongside a
 * reseed because they reference property ids from the previous generation, and
 * a dangling visit is worse than a clean slate.
 */
const USER_STORES: StoreName[] = ['visits', 'notes', 'photos', 'outbox']

async function writeSeed(bundle: SeedBundle) {
  await Promise.all([...SEEDED_STORES, ...USER_STORES].map((s) => db.clear(s)))
  await Promise.all([
    db.putAll('properties', bundle.properties),
    // The store has always existed; the seed simply never wrote to it, so every
    // territory name in the demo resolved to its own id.
    db.putAll('territories', bundle.territories),
    db.putAll('routes', bundle.routes),
    db.putAll('appointments', bundle.appointments),
    db.putAll('tasks', bundle.tasks),
    db.putAll('activity', bundle.activity),
    db.putAll('dailyStats', bundle.dailyStats),
    db.metaSet('allstar.plans', bundle.plans),
  ])
  await db.metaSet(SEED_DAY_KEY, bundle.day)
}

/**
 * Called on every boot. Installs the demo on first run, and regenerates it when
 * the calendar day has moved on. Returns true when data was (re)written.
 */
export async function ensureFreshDemo(): Promise<boolean> {
  const existing = await db.all('properties')
  const seededDay = await db.metaGet<string>(SEED_DAY_KEY)
  /*
    The device's own day, deliberately, and the one place in the app that is
    still right to ask that way: the demo has no company and no server to agree
    with, and its seeded day should look like today to whoever opens it.
  */
  const today = dayKey()

  if (existing.length > 0 && seededDay === today) return false

  await writeSeed(buildSeed())
  return true
}

/** Manual reset — hands the next pitch a pristine dataset. */
export async function resetDemo(): Promise<void> {
  await writeSeed(buildSeed())
}
