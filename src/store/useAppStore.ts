import { create } from 'zustand'
import type {
  ActivityEvent,
  Appointment,
  Note,
  NoteTag,
  OutcomeCode,
  Photo,
  PhotoCategory,
  Property,
  Route,
  Task,
  User,
  Visit,
} from '../types'
import * as db from '../lib/db'
import { uid } from '../lib/id'
import { enqueue, initSync } from '../lib/sync'
import { buildSeed, DEMO_USERS } from '../data/seed'
import { OUTCOME_TO_STATUS } from '../data/outcomes'
import { dayKey } from '../lib/format'
import { getPosition, type Position } from '../lib/geo'

/**
 * Single app store.
 *
 * Every mutating action follows the same shape:
 *   1. write the record to IndexedDB      (durable, survives an app kill)
 *   2. update React state                 (instant — no spinner, ever)
 *   3. enqueue a mutation for the server  (drains whenever there's signal)
 *
 * Nothing here awaits the network. That's the whole offline-first contract.
 */

interface AppState {
  ready: boolean
  user: User | null
  position: Position | null

  properties: Record<string, Property>
  route: Route | null
  visits: Record<string, Visit>
  notes: Record<string, Note>
  photos: Record<string, Photo>
  appointments: Record<string, Appointment>
  tasks: Record<string, Task>
  activity: ActivityEvent[]

  /** The visit currently open in Visit Mode, if any. */
  activeVisitId: string | null

  boot: () => Promise<void>
  signIn: (userId: string) => Promise<void>
  signOut: () => Promise<void>
  refreshPosition: () => Promise<void>
  setPosition: (p: Position) => void

  startVisit: (propertyId: string) => Promise<string>
  recordOutcome: (visitId: string, outcome: OutcomeCode) => Promise<void>
  addNote: (
    propertyId: string,
    body: string,
    tags: NoteTag[],
    visitId?: string,
  ) => Promise<string>
  addPhoto: (
    propertyId: string,
    img: { dataUrl: string; width: number; height: number; bytes: number },
    category: PhotoCategory,
    visitId?: string,
  ) => Promise<string>
  setNextAction: (
    visitId: string,
    type: Visit['nextActionType'],
    at?: number,
  ) => Promise<void>
  completeVisit: (visitId: string) => Promise<void>
  abandonVisit: (visitId: string) => Promise<void>

  createAppointment: (input: Omit<Appointment, 'id' | 'repId'>) => Promise<string>
  toggleTask: (taskId: string) => Promise<void>
  createTask: (input: Omit<Task, 'id' | 'repId' | 'done'>) => Promise<string>
  logComm: (propertyId: string, kind: 'call' | 'sms' | 'email', contactName?: string) => void

  skipStop: (propertyId: string) => Promise<void>
  advanceRoute: (propertyId: string) => Promise<void>
}

function indexById<T extends { id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((r) => [r.id, r]))
}

const SESSION_KEY = 'allstar.session'

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  user: null,
  position: null,
  properties: {},
  route: null,
  visits: {},
  notes: {},
  photos: {},
  appointments: {},
  tasks: {},
  activity: [],
  activeVisitId: null,

  async boot() {
    await initSync()

    let properties = await db.all<Property>('properties')

    // First run (or a cleared cache): hydrate the local store once, then never
    // again — subsequent launches read straight from IndexedDB and are instant
    // and fully offline-capable.
    if (properties.length === 0) {
      const seed = buildSeed()
      await Promise.all([
        db.putAll('properties', seed.properties),
        db.putAll('routes', [seed.route]),
        db.putAll('appointments', seed.appointments),
        db.putAll('tasks', seed.tasks),
        db.putAll('activity', seed.activity),
      ])
      properties = seed.properties
    }

    const [routes, visits, notes, photos, appointments, tasks, activity] = await Promise.all([
      db.all<Route>('routes'),
      db.all<Visit>('visits'),
      db.all<Note>('notes'),
      db.all<Photo>('photos'),
      db.all<Appointment>('appointments'),
      db.all<Task>('tasks'),
      db.all<ActivityEvent>('activity'),
    ])

    const today = dayKey()
    const route = routes.find((r) => r.date === today) ?? routes[0] ?? null

    const savedUserId = await db.metaGet<string>(SESSION_KEY)
    const user = savedUserId ? (DEMO_USERS.find((u) => u.id === savedUserId) ?? null) : null

    // An in-flight visit survives an app kill — reps close the app mid-knock.
    const openVisit = visits.find((v) => !v.endedAt)

    set({
      ready: true,
      user,
      properties: indexById(properties),
      route,
      visits: indexById(visits),
      notes: indexById(notes),
      photos: indexById(photos),
      appointments: indexById(appointments),
      tasks: indexById(tasks),
      activity: activity.sort((a, b) => b.at - a.at),
      activeVisitId: openVisit?.id ?? null,
    })

    void get().refreshPosition()
  },

  async signIn(userId) {
    const user = DEMO_USERS.find((u) => u.id === userId) ?? null
    await db.metaSet(SESSION_KEY, userId)
    set({ user })
  },

  async signOut() {
    await db.metaSet(SESSION_KEY, undefined)
    set({ user: null })
  },

  async refreshPosition() {
    const p = await getPosition()
    if (p) set({ position: p })
  },

  setPosition(p) {
    set({ position: p })
  },

  async startVisit(propertyId) {
    const user = get().user
    const id = uid('v')
    const visit: Visit = {
      id,
      propertyId,
      repId: user?.id ?? 'u_rep',
      startedAt: Date.now(),
      photoIds: [],
      pending: true,
    }

    // Stamp where the rep actually stood. Best-effort: a slow GPS fix must never
    // hold up the screen, so we attach it after the fact.
    void getPosition(6000).then((pos) => {
      if (!pos) return
      const current = get().visits[id]
      if (!current) return
      const updated: Visit = {
        ...current,
        startLocation: { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy },
      }
      void db.put('visits', updated)
      set((s) => ({ visits: { ...s.visits, [id]: updated } }))
    })

    await db.put('visits', visit)
    set((s) => ({ visits: { ...s.visits, [id]: visit }, activeVisitId: id }))
    await enqueue('visit.start', { id, propertyId, startedAt: visit.startedAt })
    return id
  },

  async recordOutcome(visitId, outcome) {
    const visit = get().visits[visitId]
    if (!visit) return
    const updated: Visit = { ...visit, outcome }
    await db.put('visits', updated)

    // The outcome is what moves the lead — status is derived, never hand-set.
    const nextStatus = OUTCOME_TO_STATUS[outcome]
    const prop = get().properties[visit.propertyId]
    const updatedProp: Property | undefined = prop
      ? {
          ...prop,
          status: nextStatus ?? prop.status,
          lastOutcome: outcome,
          lastVisitAt: Date.now(),
        }
      : undefined
    if (updatedProp) await db.put('properties', updatedProp)

    set((s) => ({
      visits: { ...s.visits, [visitId]: updated },
      properties: updatedProp
        ? { ...s.properties, [updatedProp.id]: updatedProp }
        : s.properties,
    }))
  },

  async addNote(propertyId, body, tags, visitId) {
    const id = uid('n')
    const note: Note = {
      id,
      propertyId,
      visitId,
      body,
      tags,
      authorId: get().user?.id ?? 'u_rep',
      createdAt: Date.now(),
      pending: true,
    }
    await db.put('notes', note)
    set((s) => ({ notes: { ...s.notes, [id]: note } }))

    if (visitId) {
      const visit = get().visits[visitId]
      if (visit) {
        const updated = { ...visit, noteId: id }
        await db.put('visits', updated)
        set((s) => ({ visits: { ...s.visits, [visitId]: updated } }))
      }
    }
    await enqueue('note.create', note)
    return id
  },

  async addPhoto(propertyId, img, category, visitId) {
    const id = uid('ph')
    const pos = get().position
    const photo: Photo = {
      id,
      propertyId,
      visitId,
      category,
      dataUrl: img.dataUrl,
      width: img.width,
      height: img.height,
      bytes: img.bytes,
      createdAt: Date.now(),
      capturedAt: pos ? { lat: pos.lat, lng: pos.lng } : undefined,
      pending: true,
    }
    await db.put('photos', photo)
    set((s) => ({ photos: { ...s.photos, [id]: photo } }))

    if (visitId) {
      const visit = get().visits[visitId]
      if (visit) {
        const updated = { ...visit, photoIds: [...visit.photoIds, id] }
        await db.put('visits', updated)
        set((s) => ({ visits: { ...s.visits, [visitId]: updated } }))
      }
    }
    // The blob rides the queue; on a weak link this is the row that waits.
    await enqueue('photo.create', { id, propertyId, category, bytes: photo.bytes })
    return id
  },

  async setNextAction(visitId, type, at) {
    const visit = get().visits[visitId]
    if (!visit) return
    const updated: Visit = { ...visit, nextActionType: type, nextActionAt: at }
    await db.put('visits', updated)
    set((s) => ({ visits: { ...s.visits, [visitId]: updated } }))
  },

  async completeVisit(visitId) {
    const visit = get().visits[visitId]
    if (!visit) return
    const endedAt = Date.now()
    const finished: Visit = {
      ...visit,
      endedAt,
      durationMs: endedAt - visit.startedAt,
      pending: true,
    }
    await db.put('visits', finished)

    const prop = get().properties[visit.propertyId]
    let updatedProp: Property | undefined
    if (prop) {
      updatedProp = {
        ...prop,
        lastVisitAt: endedAt,
        lastOutcome: visit.outcome ?? prop.lastOutcome,
        nextActionAt: visit.nextActionAt,
        nextActionLabel:
          visit.nextActionType && visit.nextActionType !== 'none'
            ? visit.nextActionType === 'appointment'
              ? 'Appointment'
              : visit.nextActionType === 'quote'
                ? 'Send quote'
                : 'Follow up'
            : undefined,
      }
      await db.put('properties', updatedProp)
    }

    // A scheduled next action becomes a real task so it shows up on Today.
    let newTask: Task | undefined
    if (visit.nextActionAt && visit.nextActionType && visit.nextActionType !== 'none') {
      newTask = {
        id: uid('t'),
        repId: visit.repId,
        propertyId: visit.propertyId,
        title:
          visit.nextActionType === 'appointment'
            ? `Appointment — ${prop?.address1 ?? 'property'}`
            : visit.nextActionType === 'quote'
              ? `Send quote — ${prop?.address1 ?? 'property'}`
              : `Follow up — ${prop?.address1 ?? 'property'}`,
        dueAt: visit.nextActionAt,
        done: false,
        kind:
          visit.nextActionType === 'quote'
            ? 'quote'
            : visit.nextActionType === 'appointment'
              ? 'follow_up'
              : 'follow_up',
        pending: true,
      }
      await db.put('tasks', newTask)
      await enqueue('task.create', newTask)
    }

    const event: ActivityEvent = {
      id: uid('ev'),
      propertyId: visit.propertyId,
      repId: visit.repId,
      type: 'visit',
      summary: prop?.address1 ?? 'Visit',
      at: endedAt,
      outcome: visit.outcome,
    }
    await db.put('activity', event)

    set((s) => ({
      visits: { ...s.visits, [visitId]: finished },
      properties: updatedProp ? { ...s.properties, [updatedProp.id]: updatedProp } : s.properties,
      tasks: newTask ? { ...s.tasks, [newTask.id]: newTask } : s.tasks,
      activity: [event, ...s.activity],
      activeVisitId: s.activeVisitId === visitId ? null : s.activeVisitId,
    }))

    await enqueue('visit.complete', finished)
    await get().advanceRoute(visit.propertyId)
  },

  async abandonVisit(visitId) {
    const visit = get().visits[visitId]
    if (!visit) return
    // Never recorded an outcome — treat it as if it never happened rather than
    // polluting the property's history with a phantom knock.
    await db.del('visits', visitId)
    set((s) => {
      const next = { ...s.visits }
      delete next[visitId]
      return { visits: next, activeVisitId: s.activeVisitId === visitId ? null : s.activeVisitId }
    })
  },

  async createAppointment(input) {
    const id = uid('a')
    const appt: Appointment = { ...input, id, repId: get().user?.id ?? 'u_rep', pending: true }
    await db.put('appointments', appt)
    set((s) => ({ appointments: { ...s.appointments, [id]: appt } }))
    await enqueue('appointment.create', appt)
    return id
  },

  async toggleTask(taskId) {
    const task = get().tasks[taskId]
    if (!task) return
    const updated = { ...task, done: !task.done, pending: true }
    await db.put('tasks', updated)
    set((s) => ({ tasks: { ...s.tasks, [taskId]: updated } }))
    await enqueue('task.complete', { id: taskId, done: updated.done })
  },

  async createTask(input) {
    const id = uid('t')
    const task: Task = { ...input, id, repId: get().user?.id ?? 'u_rep', done: false, pending: true }
    await db.put('tasks', task)
    set((s) => ({ tasks: { ...s.tasks, [id]: task } }))
    await enqueue('task.create', task)
    return id
  },

  logComm(propertyId, kind, contactName) {
    const prop = get().properties[propertyId]
    const event: ActivityEvent = {
      id: uid('ev'),
      propertyId,
      repId: get().user?.id ?? 'u_rep',
      type: kind === 'email' ? 'sms' : kind,
      summary:
        kind === 'call'
          ? `Called ${contactName ?? prop?.address1 ?? ''}`.trim()
          : kind === 'sms'
            ? `Texted ${contactName ?? prop?.address1 ?? ''}`.trim()
            : `Emailed ${contactName ?? prop?.address1 ?? ''}`.trim(),
      at: Date.now(),
    }
    void db.put('activity', event)
    set((s) => ({ activity: [event, ...s.activity] }))
    void enqueue('comm.log', { propertyId, kind, at: event.at })
  },

  async skipStop(propertyId) {
    const route = get().route
    if (!route) return
    const stops = route.stops.map((s) =>
      s.propertyId === propertyId ? { ...s, status: 'skipped' as const } : s,
    )
    const next = promoteNextStop({ ...route, stops })
    await db.put('routes', next)
    set({ route: next })
    await enqueue('route.stop', { routeId: route.id, propertyId, status: 'skipped' })
  },

  async advanceRoute(propertyId) {
    const route = get().route
    if (!route) return
    const stops = route.stops.map((s) =>
      s.propertyId === propertyId
        ? { ...s, status: 'done' as const, completedAt: Date.now() }
        : s,
    )
    const next = promoteNextStop({ ...route, stops })
    await db.put('routes', next)
    set({ route: next })
    await enqueue('route.stop', { routeId: route.id, propertyId, status: 'done' })
  },
}))

/** Keeps exactly one stop `active` — the one the "Next" card points at. */
function promoteNextStop(route: Route): Route {
  const hasActive = route.stops.some((s) => s.status === 'active')
  if (hasActive) return route
  const nextIdx = route.stops.findIndex((s) => s.status === 'pending')
  if (nextIdx === -1) return route
  const stops = route.stops.map((s, i) =>
    i === nextIdx ? { ...s, status: 'active' as const } : s,
  )
  return { ...route, stops }
}

/* --- Derived selectors ---------------------------------------------------- */

export function useProperty(id?: string): Property | undefined {
  return useAppStore((s) => (id ? s.properties[id] : undefined))
}

export function useRouteProgress() {
  return useAppStore((s) => {
    const route = s.route
    if (!route) return { done: 0, total: 0, remaining: 0, pct: 0 }
    const done = route.stops.filter((x) => x.status === 'done').length
    const skipped = route.stops.filter((x) => x.status === 'skipped').length
    const total = route.stops.length
    return {
      done,
      skipped,
      total,
      remaining: total - done - skipped,
      pct: total ? Math.round((done / total) * 100) : 0,
    }
  })
}
