import { dayKeyIn } from './day'
import type { Task } from '../types'

/**
 * Where a follow-up stands, by the company's calendar day.
 *
 * Follow-ups are `tasks` rows (a title, a due time, done or not, the rep who
 * made it). "Overdue" used to be `dueAt < now`, so a call booked for 5pm was
 * overdue at 5:01 the same afternoon and there was no way to ask "what is due
 * today". This answers both, on the day the company counts on — the same day
 * the reports use — rather than the instant.
 */
export type FollowUpState = 'overdue' | 'today' | 'upcoming'

export function followUpState(dueAt: number, tz?: string | null, now = Date.now()): FollowUpState {
  const due = dayKeyIn(dueAt, tz)
  const today = dayKeyIn(now, tz)
  return due < today ? 'overdue' : due === today ? 'today' : 'upcoming'
}

export const FOLLOW_UP_LABEL: Record<FollowUpState, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  upcoming: 'Upcoming',
}

export type FollowUpFilter = 'any' | 'overdue' | 'today' | 'open' | 'none'

export const FOLLOW_UP_FILTERS: { key: FollowUpFilter; label: string }[] = [
  { key: 'any', label: 'Follow-up: any' },
  { key: 'overdue', label: 'Follow-up overdue' },
  { key: 'today', label: 'Follow-up due today' },
  { key: 'open', label: 'Has an open follow-up' },
  { key: 'none', label: 'No open follow-up' },
]

/** Each lead's earliest open (not done) task. */
export function openTaskByLead(tasks: Iterable<Task>): Map<string, Task> {
  const by = new Map<string, Task>()
  for (const t of tasks) {
    if (t.done || !t.propertyId) continue
    const cur = by.get(t.propertyId)
    if (!cur || t.dueAt < cur.dueAt) by.set(t.propertyId, t)
  }
  return by
}

export function matchesFollowUp(task: Task | undefined, filter: FollowUpFilter, tz?: string | null, now = Date.now()): boolean {
  if (filter === 'any') return true
  if (filter === 'none') return !task
  if (!task) return false
  if (filter === 'open') return true
  return followUpState(task.dueAt, tz, now) === filter
}
