import { useMemo } from 'react'
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
  TeamMember,
  Territory,
  User,
  Visit,
} from '../types'
import * as db from '../lib/db'
import { uid } from '../lib/id'
import { enqueue, drain, initSync } from '../lib/sync'
import { DEMO_USERS, FIELD_REPS } from '../data/seed'
import { ensureFreshDemo, resetDemo } from '../lib/demo'
import { fetchBootstrap } from '../lib/api'
import { apiCreateTerritory, apiLogin, apiLogout, apiUsers } from '../lib/http'
import { applyBootstrap, outboxPending, wipeCachedData } from '../lib/hydrate'
import {
  clearSession,
  currentSession,
  liveToken,
  loadSession,
  onAuthExpired,
  initialsOf,
  saveSession,
  userFromDTO,
} from '../lib/session'
import { OUTCOME_TO_STATUS } from '../data/outcomes'
import { dayKey } from '../lib/format'
import { pointInPolygon } from '../lib/geo'
import { getPosition, type Position } from '../lib/geo'
import type { ClientSettings } from '../lib/settings'
import { buildRoute } from '../lib/route'

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
  /**
   * Which world the app is in. `demo` is the seeded pitch dataset with no
   * server; `live` is a real account on the API. Screens that offer to reset the
   * data, or that would be lying if they showed seeded numbers, branch on this.
   */
  mode: 'demo' | 'live'
  /** Set when a live session expired mid-session, so the login screen can say so. */
  sessionExpired: boolean
  /** True while a bootstrap refresh is in flight, for pull-to-refresh. */
  refreshing: boolean

  properties: Record<string, Property>
  route: Route | null
  /** Every rep's route for today; `route` is the signed-in user's. */
  routes: Route[]
  visits: Record<string, Visit>
  notes: Record<string, Note>
  photos: Record<string, Photo>
  appointments: Record<string, Appointment>
  tasks: Record<string, Task>
  activity: ActivityEvent[]
  /** Names for the territory ids on properties. Empty in demo mode. */
  territories: Record<string, Territory>
  /** How this company has customised the field app. Empty means defaults. */
  settings: ClientSettings
  /**
   * Everyone with an account. The real roster in live mode, the seeded team in
   * demo mode — so every screen that names a rep reads from one place.
   */
  team: TeamMember[]

  /** The visit currently open in Visit Mode, if any. */
  activeVisitId: string | null

  boot: () => Promise<void>
  /** Read the local cache into state. Shared by boot and both sign-in paths. */
  loadLocal: (user: User | null, mode: 'demo' | 'live') => Promise<void>
  /** Called when the API rejects our token — drops to login, keeps the outbox. */
  handleAuthExpired: () => Promise<void>
  /** Real credentials against the API. Throws so the form can show why. */
  signInLive: (email: string, password: string) => Promise<void>
  /** The seeded pitch dataset — no account, no network. */
  signInDemo: (userId: string) => Promise<void>
  /** Pull the server's view of the world down again. Live mode only. */
  refreshFromServer: () => Promise<void>
  /** Re-read the team roster. Office roles only — a rep has no business with it. */
  loadTeam: () => Promise<void>
  /** Demo-only: hand the next pitch a pristine dataset. */
  resetDemoData: () => Promise<void>
  /**
   * Create a territory from a drawn outline and move the leads inside it.
   *
   * Live: the server matches the shape against the database and is the
   * authority. Demo: the same work locally, because a feature you cannot show
   * in the demo is a feature nobody buys.
   */
  createTerritory: (input: {
    name: string
    repId: string | null
    boundary: { lat: number; lng: number }[]
  }) => Promise<{ assigned: number }>
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
  /** Plan today's walking order from the rep's own unworked leads. */
  buildTodayRoute: (size?: number) => Promise<Route | null>
}

function indexById<T extends { id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((r) => [r.id, r]))
}

/**
 * The demo's roster, in the same shape the server returns.
 *
 * Keeping the two behind one type is what lets every screen stop asking which
 * world it's in — the pitch shows a full team, a live account shows the real one,
 * and neither screen needs to know.
 */
function seedTeam(mode: 'demo' | 'live'): TeamMember[] {
  if (mode === 'live') return []
  return [
    ...FIELD_REPS.map((r) => ({
      id: r.id,
      name: r.name,
      role: 'field_rep' as const,
      phone: r.phone,
      active: true,
      initials: r.initials,
    })),
    ...DEMO_USERS.filter((u) => u.role !== 'field_rep').map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: true,
      initials: u.avatarInitials,
    })),
  ]
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  user: null,
  position: null,
  mode: 'demo',
  sessionExpired: false,
  refreshing: false,
  properties: {},
  route: null,
  routes: [],
  visits: {},
  notes: {},
  photos: {},
  appointments: {},
  tasks: {},
  activity: [],
  territories: {},
  team: [],
  settings: {},
  activeVisitId: null,

  async boot() {
    // The session is read *before* the outbox is started. `initSync` drains on
    // start-up, and a drain that runs without knowing who is signed in has no
    // correct destination for the writes. `pushMutations` refuses to send in
    // that state as a backstop; this ordering is what makes it never arise.
    const session = await loadSession()

    await initSync()

    // A live session can die while the phone is in a pocket. Discovering that
    // happens inside a background drain, where there's no screen to raise it on
    // — so the store listens and moves the app to the login screen itself.
    onAuthExpired(() => {
      void get().handleAuthExpired()
    })

    if (session?.mode === 'live') {
      // The cache is already on disk from the last session; read it and paint.
      // The refresh runs behind the first render so a rep with one bar sees
      // yesterday's route immediately instead of a spinner.
      await get().loadLocal(session.user, 'live')
      void get().refreshFromServer()
      void get().loadTeam()
    } else if (session?.mode === 'demo') {
      // Installs the demo on first run, and regenerates it when the calendar day
      // has rolled over so the pitch never opens to empty sections.
      await ensureFreshDemo()
      await get().loadLocal(DEMO_USERS.find((u) => u.id === session.userId) ?? null, 'demo')
    } else {
      // Signed out. Nothing is seeded yet — a rep signing in with real
      // credentials should never have 160 fictional addresses written to their
      // phone first, and the demo seeds itself the moment it's chosen.
      set({ ready: true, user: null, mode: 'demo' })
      return
    }

    void get().refreshPosition()
  },

  /** Read whatever is cached locally into state. Shared by every entry path. */
  async loadLocal(user, mode) {
    const [
      properties,
      routes,
      visits,
      notes,
      photos,
      appointments,
      tasks,
      activity,
      territories,
      team,
    ] =
      await Promise.all([
        db.all<Property>('properties'),
        db.all<Route>('routes'),
        db.all<Visit>('visits'),
        db.all<Note>('notes'),
        db.all<Photo>('photos'),
        db.all<Appointment>('appointments'),
        db.all<Task>('tasks'),
        db.all<ActivityEvent>('activity'),
        db.all<Territory>('territories'),
        db.all<TeamMember>('team'),
      ])
    const settings = (await db.metaGet<ClientSettings>('allstar.settings')) ?? {}

    // An in-flight visit survives an app kill — reps close the app mid-knock.
    const openVisit = visits.find((v) => !v.endedAt)

    set({
      ready: true,
      user,
      mode,
      routes,
      properties: indexById(properties),
      route: routeFor(routes, user?.id),
      visits: indexById(visits),
      notes: indexById(notes),
      photos: indexById(photos),
      appointments: indexById(appointments),
      tasks: indexById(tasks),
      activity: activity.sort((a, b) => b.at - a.at),
      territories: indexById(territories),
      team: team.length ? team : seedTeam(mode),
      settings,
      activeVisitId: openVisit?.id ?? null,
    })
  },

  async signInLive(email, password) {
    // Deliberately awaited and allowed to throw: this is the one place in the
    // app where the rep is standing still, looking at a form, and a failure has
    // to be shown rather than queued.
    const { token, user: dto } = await apiLogin(email.trim(), password)
    const user = userFromDTO(dto)

    // Whoever was here before — a demo, or another rep on a shared phone — their
    // cached rows go before this account's arrive. Queued work is left alone.
    await wipeCachedData()
    await saveSession({ mode: 'live', token, user })

    try {
      const dtoBundle = await fetchBootstrap()
      // A fresh sign-in has no local rows worth preserving — the cache was
      // wiped above — so this is a clean replace.
      if (dtoBundle) await applyBootstrap(dtoBundle)
    } catch {
      // Signed in, but the data didn't arrive. That's a legitimate state for
      // this app: the session is real, the cache is empty, and the next refresh
      // fills it. Better than refusing a login that actually succeeded.
    }

    await get().loadLocal(user, 'live')
    void get().loadTeam()
    set({ sessionExpired: false })
    void get().refreshPosition()
    // Anything queued before the session lapsed can go up now.
    void drain()
  },

  async signInDemo(userId) {
    await wipeCachedData()
    await saveSession({ mode: 'demo', userId })
    await ensureFreshDemo()
    await get().loadLocal(DEMO_USERS.find((u) => u.id === userId) ?? null, 'demo')
    set({ sessionExpired: false })
    void get().refreshPosition()
  },

  async loadTeam() {
    const state = get()
    if (state.mode !== 'live') {
      set({ team: seedTeam('demo') })
      return
    }
    // Reps get a 403 and don't need one — asking would be a guaranteed error in
    // the console on every boot of a field account.
    if (state.user?.role === 'field_rep') return
    const token = liveToken()
    if (!token) return
    try {
      const { users } = await apiUsers(token)
      const team: TeamMember[] = users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        phone: u.phone,
        active: u.active,
        pending: u.pending,
        initials: initialsOf(u.name),
      }))
      await db.clear('team')
      await db.putAll('team', team)
      set({ team })
    } catch {
      // The cached roster is still on screen; a failed refresh shouldn't blank
      // every name in the console.
    }
  },

  async refreshFromServer() {
    if (get().mode !== 'live' || get().refreshing) return
    set({ refreshing: true })
    try {
      // Sampled before the request: work that drains while the bootstrap is in
      // flight is work the response cannot know about, and treating that
      // response as complete would delete it.
      const hadPendingWork = await outboxPending()
      const dto = await fetchBootstrap()
      if (dto) {
        await applyBootstrap(dto, hadPendingWork)
        await get().loadLocal(userFromDTO(dto.user), 'live')
        await get().loadTeam()
      }
    } catch {
      // Offline, or the server is unhappy. The cache is still valid and the sync
      // chip already tells the rep where they stand — no error to raise here.
    } finally {
      set({ refreshing: false })
    }
  },

  /**
   * The session died while the app was open. Drop back to the login screen
   * without touching the outbox: those rows are the rep's work, and they drain
   * as soon as someone signs in again.
   */
  async handleAuthExpired() {
    if (get().mode !== 'live') return
    await clearSession()
    set({ user: null, sessionExpired: true })
  },

  async resetDemoData() {
    if (get().mode !== 'demo') return
    await resetDemo()
    const current = get().user
    await get().loadLocal(current, 'demo')
  },

  async createTerritory({ name, repId, boundary }) {
    if (boundary.length < 3) throw new Error('An area needs at least three points.')
    const token = liveToken()

    if (token) {
      const res = await apiCreateTerritory(token, { name, repId, boundary })
      // The server has moved rows; pull its view back rather than patching a
      // guess into local state and hoping the two agree.
      await get().refreshFromServer()
      return { assigned: res.assigned }
    }

    /*
      Demo, or a live account with no signal: do it locally against what is on
      the device. Written to IndexedDB first like every other write in this app,
      so it survives a reload.
    */
    const id = `t_drawn_${Date.now().toString(36)}`
    const territory: Territory = { id, name, repId: repId ?? undefined, boundary }
    const inside = Object.values(get().properties).filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && pointInPolygon(p, boundary),
    )
    const moved = inside.map((p) => ({
      ...p,
      territoryId: id,
      assignedRepId: repId ?? p.assignedRepId,
      updatedAt: Date.now(),
    }))

    await db.put('territories', territory)
    if (moved.length > 0) await db.putAll('properties', moved)

    set((state) => ({
      territories: { ...state.territories, [id]: territory },
      properties: {
        ...state.properties,
        ...Object.fromEntries(moved.map((p) => [p.id, p])),
      },
    }))
    return { assigned: moved.length }
  },

  async signOut() {
    const session = currentSession()
    if (session?.mode === 'live') {
      // Best-effort revoke. A token we can't reach the server to kill still
      // expires on its own, and the rep is signed out locally either way.
      void apiLogout(session.token).catch(() => {})
    }
    await clearSession()
    await wipeCachedData()
    set({
      user: null,
      mode: 'demo',
      sessionExpired: false,
      properties: {},
      routes: [],
      route: null,
      visits: {},
      notes: {},
      photos: {},
      appointments: {},
      tasks: {},
      activity: [],
      territories: {},
      team: [],
      settings: {},
      activeVisitId: null,
    })
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

    // `nextActionLabel` is derived on the property, not stored on the visit —
    // send it explicitly or the server writes a null over the label the rep
    // just created, and the next bootstrap drops "Send quote" off the card.
    await enqueue('visit.complete', {
      ...finished,
      nextActionLabel: updatedProp?.nextActionLabel,
    })
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

  async buildTodayRoute(size) {
    const state = get()
    const user = state.user
    if (!user) return null

    // A rep's own patch. Office roles building a route would be planning
    // somebody else's day, which is what the console is for.
    const mine = Object.values(state.properties).filter(
      (p) => user.role !== 'field_rep' || p.assignedRepId === user.id,
    )

    const route = buildRoute(mine, {
      repId: user.id,
      from: state.position ?? undefined,
      size,
    })
    if (!route) return null

    await db.put('routes', route)
    set((s) => ({
      route,
      routes: [...s.routes.filter((r) => r.id !== route.id), route],
    }))
    await enqueue('route.create', route)
    return route
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

/**
 * The route to drive the Today screen from.
 *
 * Field reps get their own. Managers and admins have no route of their own, so
 * they ride along with the lead rep's — their Today screen is the Overview,
 * and this only backs the shared map/route views.
 */
function routeFor(routes: Route[], userId?: string): Route | null {
  const today = dayKey()
  const todays = routes.filter((r) => r.date === today)
  const pool = todays.length ? todays : routes
  return (
    pool.find((r) => r.repId === userId) ??
    pool.find((r) => r.repId === FIELD_REPS[0].id) ??
    pool[0] ??
    null
  )
}

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

/* --- Role scoping ---------------------------------------------------------
 *
 * With a full team in the data, "my leads" and "the company's leads" are no
 * longer the same set. A rep's screens must show their own patch — otherwise
 * Dana's Today screen reports the whole team's doors as hers. Office roles keep
 * seeing everything, which is the point of their views.
 * ------------------------------------------------------------------------- */

function isRep(user: User | null): boolean {
  return user?.role === 'field_rep'
}

export function useScopedProperties(): Property[] {
  const properties = useAppStore((s) => s.properties)
  const user = useAppStore((s) => s.user)
  return useMemo(() => {
    const all = Object.values(properties)
    if (!isRep(user)) return all
    return all.filter((p) => p.assignedRepId === user?.id)
  }, [properties, user])
}

export function useMyTasks(): Task[] {
  const tasks = useAppStore((s) => s.tasks)
  const user = useAppStore((s) => s.user)
  return useMemo(() => {
    const all = Object.values(tasks)
    return (isRep(user) ? all.filter((t) => t.repId === user?.id) : all).sort(
      (a, b) => a.dueAt - b.dueAt,
    )
  }, [tasks, user])
}

export function useMyAppointments(): Appointment[] {
  const appointments = useAppStore((s) => s.appointments)
  const user = useAppStore((s) => s.user)
  return useMemo(() => {
    const all = Object.values(appointments)
    return (isRep(user) ? all.filter((a) => a.repId === user?.id) : all).sort(
      (a, b) => a.startsAt - b.startsAt,
    )
  }, [appointments, user])
}

export function useMyActivity(): ActivityEvent[] {
  const activity = useAppStore((s) => s.activity)
  const user = useAppStore((s) => s.user)
  return useMemo(
    () => (isRep(user) ? activity.filter((a) => a.repId === user?.id) : activity),
    [activity, user],
  )
}
