import { useMemo } from 'react'
import { create } from 'zustand'
import type {
  ActivityEvent,
  Appointment,
  DailyStat,
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
  LeadList,
  Contact,
} from '../types'
import * as db from '../lib/db'
import { purgeErased } from '../lib/erase-local'
import { uid } from '../lib/id'
import { enqueue, drain, initSync } from '../lib/sync'
import { initPhotoSync, onPhotoUpdated } from '../lib/photos'
import { DEMO_USERS, FIELD_REPS } from '../data/seed'
import { ensureFreshDemo, resetDemo } from '../lib/demo'
import { fetchBootstrap } from '../lib/api'
import {
  apiCreateList,
  apiCreateTerritory,
  apiDeleteList,
  apiDeleteTerritory,
  apiLogin,
  apiLogout,
  apiRenameTerritory,
  apiSetListReps,
  apiUsers,
  apiJoin,
  apiMe,
  type SessionUserDTO,
} from '../lib/http'
import { canSee, leadIdsViaLists, listsContaining, listsFor, withMembers } from '../lib/leadLists'
import { applyBootstrap, leadListFromDTO, outboxPending, wipeCachedData } from '../lib/hydrate'
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
  /**
   * Per-rep daily totals, thirty days back, straight from bootstrap.
   *
   * An array rather than a map keyed by id: nothing ever looks one of these up
   * on its own, and every reader wants a filtered sum across a date range.
   */
  dailyStats: DailyStat[]
  /** Names for the territory ids on properties. Empty in demo mode. */
  territories: Record<string, Territory>
  /**
   * The lists this person can see — handed to them, or made by them; every
   * live list for an office role. Members and reps carried flat. What a rep
   * may *see* on the map is derived from these in `useScopedProperties`.
   */
  leadLists: Record<string, LeadList>
  /** How this company has customised the field app. Empty means defaults. */
  settings: ClientSettings
  /**
   * The company's reporting calendar, as the server sees it.
   *
   * Empty until a bootstrap has landed. The field app does not yet bucket its
   * own screens by it — a phone in the company's own timezone gets the same
   * answer — but the console needs it to show and change it.
   */
  timezone: string
  /**
   * Everyone with an account. The real roster in live mode, the seeded team in
   * demo mode — so every screen that names a rep reads from one place.
   */
  team: TeamMember[]
  /**
   * Names for everyone on the account, for a rep's phone.
   *
   * `team` is the office's roster and stays empty for a field rep, who is not
   * allowed `/api/users`. This is the names-only list bootstrap sends everybody
   * so a rep id can be shown as a person — on the standings, and on a house's
   * sheet under "Assigned to".
   */
  roster: { id: string; name: string; role: string; active: boolean; avatarUrl?: string }[]

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
  /**
   * Redeem a company join code: the account is made (or a pending invitation
   * claimed) and the person is signed in, with onboarding ahead of them.
   * Throws like `signInLive` — the person is looking at a form.
   */
  joinWithCode: (input: {
    code: string
    email: string
    password: string
    firstName?: string
    lastName?: string
  }) => Promise<void>
  /**
   * Re-read who I am from the server — profile, onboarding, badge, company.
   * Called after every onboarding step, and at boot, so an admin's reset or a
   * new required version reaches the phone. Quiet on failure: the cached user
   * stands until the server can be asked.
   */
  refreshMe: () => Promise<void>
  /** Pull the server's view of the world down again. Live mode only. */
  refreshFromServer: () => Promise<void>
  /**
   * Drop leads this device should no longer hold — memory and IndexedDB both —
   * because the server has just erased them. The map and every list read from
   * the same `properties`, so this is what makes pins vanish on the tap rather
   * than on the next refresh.
   */
  forgetProperties: (ids: string[]) => Promise<void>
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
  }) => Promise<{ id: string; assigned: number }>
  /**
   * Rename a territory, and delete one.
   *
   * Added because neither existed: a drawn patch could be created and its rep
   * changed, and that was the whole vocabulary — so a typo was permanent and a
   * shape round the wrong streets could only be abandoned where it lay.
   *
   * Deleting keeps the leads. They go back to the unassigned bucket, which is
   * where they were before anybody drew round them; `released` is how many the
   * server actually moved, so the console reports a fact rather than its own
   * arithmetic.
   */
  renameTerritory: (id: string, name: string) => Promise<void>
  deleteTerritory: (id: string) => Promise<{ released: number }>
  /**
   * Lead lists.
   *
   * Two kinds of write, and they take different roads on purpose.
   *
   * A rep organising their own week — a list from houses they can see, a
   * rename, a house added or dropped, an archive — is written locally first and
   * queued, like a visit or a note. It works in a dead zone, and the outbox
   * applies it through the same server function the console uses, so a refusal
   * comes back as a rejected mutation rather than never being noticed.
   *
   * A manager's write — drawing round an area, handing a list to reps — needs
   * the server's answer: which houses are actually inside, who is actually on
   * the team. Those go to the server and pull its view back, and offline they
   * say so rather than guess. In the demo they run locally, because a feature
   * you cannot show is a feature nobody buys.
   */
  createList: (input: {
    name: string
    description?: string
    propertyIds?: string[]
    repIds?: string[]
    boundary?: { lat: number; lng: number }[]
  }) => Promise<LeadList>
  updateList: (id: string, patch: { name?: string; description?: string; archived?: boolean }) => Promise<void>
  updateListMembers: (id: string, change: { add?: string[]; remove?: string[] }) => Promise<void>
  setListReps: (id: string, repIds: string[]) => Promise<void>
  deleteList: (id: string) => Promise<void>
  signOut: () => Promise<void>
  refreshPosition: () => Promise<void>
  setPosition: (p: Position) => void

  startVisit: (propertyId: string) => Promise<string>
  recordOutcome: (visitId: string, outcome: OutcomeCode) => Promise<void>
  /**
   * Correct a lead's address or its primary contact, at the door.
   *
   * Local first, queued second, like every other write. Status is not here:
   * it follows from a visit, and a control that set it by hand would make a
   * rep's outcomes indistinguishable from the office's bookkeeping.
   */
  updateLeadDetails: (
    propertyId: string,
    patch: {
      address1?: string
      city?: string
      state?: string
      zip?: string
      contact?: { name: string; phone?: string; email?: string }
    },
  ) => Promise<void>
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
  /** Set or clear the signed-in person's profile photo. `null` removes it. */
  setMyAvatar: (dataUrl: string | null) => Promise<void>
  /**
   * Bumped to ask for the tour.
   *
   * A counter rather than a boolean, because "show it again" has to work twice.
   * The tour is mounted in the shell — it navigates, so it cannot live inside a
   * route — and the shell reads the seen-flag once when it mounts. Clearing that
   * flag from the More screen therefore did nothing at all: nothing remounts,
   * so nothing re-reads it. This is the signal that was missing.
   */
  tourRequest: number
  requestTour: () => void
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

/**
 * Everything a sign-in does after the server has said yes.
 *
 * Shared by the password door and the join-code door, which both arrive here
 * holding a token and a person. Whoever was here before — a demo, or another
 * rep on a shared phone — their cached rows go before this account's arrive.
 * Queued work is left alone.
 */
async function enterLive(token: string, dto: SessionUserDTO): Promise<void> {
  const user = userFromDTO(dto)
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

  const store = useAppStore.getState()
  await store.loadLocal(user, 'live')
  void store.loadTeam()
  useAppStore.setState({ sessionExpired: false })
  void store.refreshPosition()
  // Anything queued before the session lapsed can go up now.
  void drain()
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  user: null,
  position: null,
  mode: 'demo',
  tourRequest: 0,
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
  dailyStats: [],
  territories: {},
  leadLists: {},
  team: [],
  roster: [],
  settings: {},
  timezone: '',
  activeVisitId: null,

  async boot() {
    // The session is read *before* the outbox is started. `initSync` drains on
    // start-up, and a drain that runs without knowing who is signed in has no
    // correct destination for the writes. `pushMutations` refuses to send in
    // that state as a backstop; this ordering is what makes it never arise.
    /*
      Ask the browser to keep what we store, and do not wait for the answer.

      Fire-and-forget because nothing on screen depends on it and a permission
      check has no business delaying first paint. Every launch, because it is
      idempotent once granted and because browsers weigh engagement — a request
      refused on the day someone installed the app is often granted a week
      later, and the only way to find out is to ask again.
    */
    void db.requestPersistence()

    const session = await loadSession()

    /*
      The photo queue writes to disk from a background drain, and the screen
      showing those photos is reading them out of this store. Without this the
      waiting dot on a photo clears on disk and stays on screen until something
      unrelated causes a re-render — which, on the visit screen a rep is staring
      at, is never.
    */
    onPhotoUpdated((photo) => {
      /*
        New rows as well as changed ones. The guard that used to be here — only
        patch a photo the store already knew about — was there to stop a deleted
        photo reappearing, and it silently swallowed every photo arriving from
        the server: the office would fetch a rep's roof shots, write them to
        disk, and see an empty strip until something else forced a reload.
      */
      set((s) => ({ photos: { ...s.photos, [photo.id]: photo } }))
    })

    // A live session can die while the phone is in a pocket. Discovering that
    // happens inside a background drain, where there's no screen to raise it on
    // — so the store listens and moves the app to the login screen itself.
    onAuthExpired(() => {
      void get().handleAuthExpired()
    })

    /*
      Started, never awaited.

      These two read a timestamp and count two tables for the sync chip. Nothing
      on any screen waits for those numbers, but they used to be `await`ed here,
      ahead of the `loadLocal` below that actually fills the store — which
      quietly made every pixel in the app depend on two IndexedDB reads
      completing. When one of them didn't, `loadLocal` never ran, `ready` never
      flipped, and the app sat on "Loading your territory…" forever: no error,
      no timeout, no self-heal, because the code that would have healed it was
      parked behind the same await. That is #40. Dropping the `await` removes
      the failure mode outright rather than guessing which read was slow.

      Above the branch, not below it, because the signed-out path returns early
      and `boot` is the only caller. Underneath the counts, `initSync` registers
      the online and visibilitychange listeners that retry a drain when a rep
      regains signal — skipping them for anyone who signs in from a cold start
      would strand queued work until the next launch.

      What is still load-bearing: `loadSession()` has already resolved, because
      a drain that does not know who is signed in has no correct destination for
      the writes.
    */
    void initSync()
    void initPhotoSync()

    if (session?.mode === 'live') {
      // The cache is already on disk from the last session; read it and paint.
      // The refresh runs behind the first render so a rep with one bar sees
      // yesterday's route immediately instead of a spinner.
      await get().loadLocal(session.user, 'live')
      void get().refreshFromServer()
      void get().loadTeam()
      // An admin's reset, or a new required version, reaches this phone here.
      void get().refreshMe()
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
      leadLists,
      team,
      dailyStats,
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
        db.all<LeadList>('leadLists'),
        db.all<TeamMember>('team'),
        /*
          Thirty days of per-rep daily totals, cached by bootstrap and until now
          written to disk and never read. The standings board needs it to answer
          "this week" and "this month" — anything longer than today cannot come
          from the device's own activity log, which only holds what this phone
          did.
        */
        db.all<DailyStat>('dailyStats'),
      ])
    const settings = (await db.metaGet<ClientSettings>('allstar.settings')) ?? {}
    const timezone = (await db.metaGet<string>('allstar.timezone')) ?? ''
    /*
      The profile photo, keyed by user id rather than folded into the session.

      Demo mode has no session user to write to — its people come from a seed
      file — so an avatar stored in the session would be a live-only feature for
      no reason. Keyed here it survives a reload in both modes, and a shared
      phone shows the right face for whoever is signed in.
    */
    /*
      The cached roster from bootstrap. Only used when the `team` store is empty,
      which is the field-rep case: the office fills that store from `/api/users`
      with e-mail and invite state, and this is the names-only version a rep gets
      so the standings can say "Dana" rather than "u_rep_2".
    */
    const roster =
      (await db.metaGet<
        { id: string; name: string; role: string; active: boolean; avatarUrl?: string }[]
      >('allstar.roster')) ?? []

    const localAvatar = user ? await db.metaGet<string>(`allstar.avatar.${user.id}`) : undefined
    /*
      Local first, roster second.

      The local copy wins because it is the one just set — a photo chosen
      offline must not be replaced by the server's older idea of it on the next
      reload. The roster is the fallback that makes a *new* device work: sign in
      on a replacement phone and your face arrives with everyone else's, without
      the login endpoint having to learn about avatars at all.
    */
    const myAvatar =
      localAvatar ??
      (user
        ? // Both, because they are different people's paths through this code:
          // the office fills the `team` store from /api/users, a field rep only
          // ever gets the names-only roster off bootstrap. Checking one would
          // work perfectly for whoever wrote it and not at all for the other.
          (team.find((m) => m.id === user.id)?.avatarUrl ??
          roster.find((m) => m.id === user.id)?.avatarUrl)
        : undefined)
    const me = user && myAvatar ? { ...user, avatarUrl: myAvatar } : user

    // An in-flight visit survives an app kill — reps close the app mid-knock.
    const openVisit = visits.find((v) => !v.endedAt)

    set({
      ready: true,
      user: me,
      mode,
      roster,
      routes,
      properties: indexById(properties),
      route: routeFor(routes, me?.id, timezone),
      visits: indexById(visits),
      notes: indexById(notes),
      photos: indexById(photos),
      appointments: indexById(appointments),
      tasks: indexById(tasks),
      activity: activity.sort((a, b) => b.at - a.at),
      dailyStats,
      territories: indexById(territories),
      leadLists: indexById(leadLists),
      team: team.length
        ? team
        : roster.length
          ? roster.map((m) => ({
              id: m.id,
              name: m.name,
              email: '',
              role: m.role as TeamMember['role'],
              active: m.active,
              initials: initialsOf(m.name),
              avatarUrl: m.avatarUrl,
            }))
          : seedTeam(mode),
      settings,
      timezone,
      activeVisitId: openVisit?.id ?? null,
    })
  },

  async signInLive(email, password) {
    // Deliberately awaited and allowed to throw: this is the one place in the
    // app where the rep is standing still, looking at a form, and a failure has
    // to be shown rather than queued.
    const { token, user: dto } = await apiLogin(email.trim(), password)
    await enterLive(token, dto)
  },

  async joinWithCode(input) {
    const { token, user: dto } = await apiJoin({
      code: input.code.trim(),
      email: input.email.trim(),
      password: input.password,
      firstName: input.firstName?.trim() || undefined,
      lastName: input.lastName?.trim() || undefined,
    })
    await enterLive(token, dto)
  },

  async refreshMe() {
    const token = liveToken()
    if (!token || get().mode !== 'live') return
    try {
      const { user: dto } = await apiMe(token)
      const current = get().user
      // The photo is overlaid from the device and never in /api/me's mapping;
      // keep the one already on screen.
      const user = { ...userFromDTO(dto), avatarUrl: current?.avatarUrl }
      set({ user })
      await saveSession({ mode: 'live', token, user: { ...user, avatarUrl: undefined } })
    } catch {
      // Offline, or the server is unhappy. What the phone already knows stands.
    }
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
    /*
      Reps get a 403 from `/api/users`, so they do not ask. They are not left
      without a roster though: bootstrap carries names and initials for everyone,
      which is what turns a `rep_id` on the standings into a person. The office
      still calls this for the fuller version — e-mail, phone, invite state —
      which is the part a rep has no business with.
    */
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
        firstName: u.firstName,
        lastName: u.lastName,
        jobTitle: u.jobTitle,
        teamId: u.teamId,
        teamName: u.teamName,
        invitation: u.invitation,
        invitedAt: u.invitedAt,
        resentAt: u.resentAt,
        openedAt: u.openedAt,
        onboarding: u.onboarding,
        onboardingStep: u.onboardingStep,
        badge: u.badge,
        badgeExpiresAt: u.badgeExpiresAt,
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt,
      }))
      await db.clear('team')
      await db.putAll('team', team)
      set({ team })
    } catch {
      // The cached roster is still on screen; a failed refresh shouldn't blank
      // every name in the console.
    }
  },

  async forgetProperties(ids) {
    if (ids.length === 0) return
    const gone = new Set(ids)
    set((state) => {
      const properties = { ...state.properties }
      for (const id of gone) delete properties[id]
      return { properties }
    })
    // The same purge a bootstrap runs for an erased id: the property, its
    // visits, notes, photos and queued work, so nothing on this device can
    // put it back. See erase-local.ts.
    await purgeErased(ids)
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
      return { id: res.territory.id, assigned: res.assigned }
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
    return { id, assigned: moved.length }
  },

  /*
    Rename and delete, live and local, sharing the shape of every other write
    here: the server is asked when there is a token, and the device does it
    itself in the demo so the feature can be shown.

    The local delete has to do by hand what `ON DELETE SET NULL` does on the
    server — walk the leads carrying this territory and clear the field — and it
    writes them to IndexedDB before touching state, so a reload does not bring
    a deleted patch back.
  */
  async renameTerritory(id, name) {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Give the area a name.')
    const token = liveToken()

    if (token) {
      await apiRenameTerritory(token, id, trimmed)
      await get().refreshFromServer()
      return
    }

    const existing = get().territories[id]
    if (!existing) throw new Error('No such territory.')
    const clash = Object.values(get().territories).some(
      (t) => t.id !== id && t.name.toLowerCase() === trimmed.toLowerCase(),
    )
    if (clash) throw new Error('A territory already has that name.')

    const territory: Territory = { ...existing, name: trimmed }
    await db.put('territories', territory)
    set((state) => ({ territories: { ...state.territories, [id]: territory } }))
  },

  async deleteTerritory(id) {
    const token = liveToken()

    if (token) {
      const res = await apiDeleteTerritory(token, id)
      await get().refreshFromServer()
      return { released: res.released }
    }

    if (!get().territories[id]) throw new Error('No such territory.')
    /*
      The rep stays on the lead. Which patch a house belongs to and who walks
      it are two separate facts, and clearing the second here would empty a
      rep's day because somebody tidied a map.
    */
    const released = Object.values(get().properties)
      .filter((p) => p.territoryId === id)
      .map((p) => ({ ...p, territoryId: undefined, updatedAt: Date.now() }))

    if (released.length > 0) await db.putAll('properties', released)
    await db.del('territories', id)

    set((state) => {
      const territories = { ...state.territories }
      delete territories[id]
      return {
        territories,
        properties: {
          ...state.properties,
          ...Object.fromEntries(released.map((p) => [p.id, p])),
        },
      }
    })
    return { released: released.length }
  },

  async createList({ name, description, propertyIds = [], repIds = [], boundary }) {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Give the list a name.')
    const token = liveToken()
    const managerial = !!boundary?.length || repIds.length > 0

    if (token && managerial) {
      /*
        The server is the authority on which houses lie inside a shape and on
        who is on the team, so a drawn or assigned list is not guessed at
        locally. Offline this throws a NetworkError, which the screen turns into
        "needs a connection" — better than a list that claims houses the server
        would count differently.
      */
      const res = await apiCreateList(token, {
        name: trimmed,
        description,
        propertyIds,
        repIds,
        boundary,
      })
      await get().refreshFromServer()
      return get().leadLists[res.list.id] ?? leadListFromDTO(res.list)
    }

    /*
      A rep's own list, or the demo. Local first, queued second, like every
      other write in this app. The id is minted here and the server keeps it,
      so a retry after a lost reply is a duplicate rather than a second list.
    */
    const now = Date.now()
    const visible = new Set(useScopedIds(get()))
    let leadIds = propertyIds.filter((id) => visible.has(id))
    if (boundary?.length) {
      // Demo only — the live path above took the drawn case to the server.
      leadIds = Object.values(get().properties)
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && pointInPolygon(p, boundary))
        .map((p) => p.id)
    }
    const list: LeadList = {
      id: uid('ll'),
      name: trimmed,
      description: description?.trim() || undefined,
      createdBy: get().user?.id,
      boundary,
      archived: false,
      createdAt: now,
      updatedAt: now,
      leadIds: [...new Set(leadIds)],
      repIds: [...new Set(repIds)],
      pending: !!token,
    }
    await db.put('leadLists', list)
    set((state) => ({ leadLists: { ...state.leadLists, [list.id]: list } }))
    if (token) {
      await enqueue('list.create', {
        id: list.id,
        name: list.name,
        description: list.description,
        propertyIds: list.leadIds,
      })
    }
    return list
  },

  async updateList(id, patch) {
    const current = get().leadLists[id]
    if (!current) throw new Error('That list is no longer here.')
    const name = patch.name?.trim()
    if (patch.name !== undefined && !name) throw new Error('Give the list a name.')
    const next: LeadList = {
      ...current,
      ...(name !== undefined ? { name } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() || undefined } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      updatedAt: Date.now(),
    }
    await db.put('leadLists', next)
    set((state) => ({ leadLists: { ...state.leadLists, [id]: next } }))
    if (liveToken()) await enqueue('list.update', { id, ...patch, name })
  },

  async updateListMembers(id, { add = [], remove = [] }) {
    const current = get().leadLists[id]
    if (!current) throw new Error('That list is no longer here.')
    // Only houses this person can see. The server applies the same rule and
    // reports what it skipped; agreeing here means the screen never shows a
    // house on a list that the next refresh takes off again.
    const visible = new Set(useScopedIds(get()))
    const allowed = add.filter((p) => visible.has(p))
    if (!allowed.length && !remove.length) return
    const next = withMembers(current, allowed, remove)
    await db.put('leadLists', next)
    set((state) => ({ leadLists: { ...state.leadLists, [id]: next } }))
    if (liveToken()) await enqueue('list.members', { id, add: allowed, remove })
  },

  async setListReps(id, repIds) {
    const token = liveToken()
    if (token) {
      await apiSetListReps(token, id, repIds)
      await get().refreshFromServer()
      return
    }
    const current = get().leadLists[id]
    if (!current) throw new Error('That list is no longer here.')
    const next = { ...current, repIds: [...new Set(repIds)], updatedAt: Date.now() }
    await db.put('leadLists', next)
    set((state) => ({ leadLists: { ...state.leadLists, [id]: next } }))
  },

  async deleteList(id) {
    /*
      Online only, deliberately. Archiving is the offline-safe way to put a list
      away; deleting is rare, final, and worth the server's confirmation. A rep
      with no signal is told to archive instead.
    */
    const token = liveToken()
    if (token) {
      await apiDeleteList(token, id)
      await get().refreshFromServer()
      return
    }
    await db.del('leadLists', id)
    set((state) => {
      const { [id]: _gone, ...rest } = state.leadLists
      return { leadLists: rest }
    })
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
      dailyStats: [],
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
      /*
        Blank, never a borrowed identity. This used to fall back to 'u_rep',
        the demo's first rep, so a record written with nobody signed in would
        have carried a fictional author into a real database. The screen
        cannot be reached signed out, which is why it never fired — but the
        server stamps the session's user on arrival anyway, so the client's
        copy is a local label and an empty one reads as "no rep", which is
        true, where a demo id reads as a person who does not work here.
      */
      repId: user?.id ?? '',
      startedAt: Date.now(),
      photoIds: [],
      pending: true,
    }

    /*
      Stamp where the rep actually stood. Best-effort: a slow GPS fix must never
      hold up the screen, so it is attached after the fact.

      Thirty seconds rather than the default two minutes. This is the one place
      the *age* of a fix is part of what it claims — a rep three houses along has
      moved far enough that the previous door's coordinates would be a false
      record of where they were. In practice the shared watcher keeps the cache
      seconds old, so this still almost never costs a request.
    */
    void getPosition(6000, 30_000).then((pos) => {
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

  async updateLeadDetails(propertyId, patch) {
    const current = get().properties[propertyId]
    if (!current) throw new Error('That lead is no longer on this phone.')
    const address1 = patch.address1?.trim()
    if (patch.address1 !== undefined && !address1) throw new Error('A lead needs an address.')

    let contacts = current.contacts
    if (patch.contact) {
      const name = patch.contact.name.trim()
      const phone = patch.contact.phone?.trim() || undefined
      const email = patch.contact.email?.trim() || undefined
      const primary = current.contacts.find((c) => c.isPrimary) ?? current.contacts[0]
      if (name) {
        const next: Contact = primary
          ? { ...primary, name, phone, email, isPrimary: true }
          : { id: uid('ct'), name, phone, email, isPrimary: true }
        contacts = primary
          ? current.contacts.map((c) => (c.id === primary.id ? next : c))
          : [next, ...current.contacts]
      } else if (primary) {
        // A name cleared is a contact removed, not a nameless one kept.
        contacts = current.contacts.filter((c) => c.id !== primary.id)
      }
    }

    const next: Property = {
      ...current,
      ...(address1 !== undefined ? { address1 } : {}),
      ...(patch.city !== undefined ? { city: patch.city.trim() } : {}),
      ...(patch.state !== undefined ? { state: patch.state.trim() } : {}),
      ...(patch.zip !== undefined ? { zip: patch.zip.trim() } : {}),
      contacts,
    }
    await db.put('properties', next)
    set((s) => ({ properties: { ...s.properties, [propertyId]: next } }))
    await enqueue('property.update', {
      id: propertyId,
      address1: next.address1,
      city: next.city,
      state: next.state,
      zip: next.zip,
      contacts: next.contacts.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        isPrimary: !!c.isPrimary,
      })),
    })
  },

  async addNote(propertyId, body, tags, visitId) {
    const id = uid('n')
    const note: Note = {
      id,
      propertyId,
      visitId,
      body,
      tags,
      authorId: get().user?.id ?? '',
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

  /**
   * Set or clear the signed-in person's profile photo.
   *
   * Local first, like everything else: it is on disk and on screen before the
   * network is consulted, so a rep can set their photo standing in a stairwell
   * and it is simply there. The queue carries it up whenever there is signal.
   *
   * Demo mode writes locally and enqueues nothing. There is no account behind a
   * demo user to attach a face to, and queueing a mutation that can never be
   * accepted would leave a permanently stuck row in the outbox — which the More
   * screen reports, in a number a prospect can see.
   */
  requestTour() {
    set((s) => ({ tourRequest: s.tourRequest + 1 }))
  },

  async setMyAvatar(dataUrl) {
    const user = get().user
    if (!user) return

    const key = `allstar.avatar.${user.id}`
    if (dataUrl) await db.metaSet(key, dataUrl)
    else await db.metaSet(key, undefined)

    const next = { ...user, avatarUrl: dataUrl ?? undefined }
    set((state) => ({
      user: next,
      // The roster carries the same face; a stale copy there would show the old
      // photo everywhere the person appears next to somebody else.
      team: state.team.map((m) =>
        m.id === user.id ? { ...m, avatarUrl: dataUrl ?? undefined } : m,
      ),
    }))

    /*
      Deliberately no write to the `team` store.

      Caching my own roster entry there looks like the obvious way to remember
      my face, and it quietly destroys the roster. A field rep's `team` store is
      empty — they get the names-only roster off bootstrap, and `loadLocal` only
      reaches for it when the store has nothing in it. One row is enough to stop
      that, so the next load would show a team of exactly one person: me. The
      board went from eight names to one, which is a bug this app has had once
      already.

      The meta key above is the durable copy of my own photo. Everyone else's
      arrives with the roster, from the server, where it belongs.
    */
    if (get().mode === 'live') await enqueue('user.avatar', { userId: user.id, dataUrl })
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
        // A door nobody owned belongs to whoever knocked it — the server applies
        // the same rule, so the phone shows it now rather than after a refresh.
        assignedRepId: prop.assignedRepId ?? visit.repId,
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
    const appt: Appointment = { ...input, id, repId: get().user?.id ?? '', pending: true }
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
    const task: Task = { ...input, id, repId: get().user?.id ?? '', done: false, pending: true }
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
      repId: get().user?.id ?? '',
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
      // The route's id and date key off the company's day, so building one at
      // 11pm does not file it under tomorrow for half the crew.
      tz: state.timezone,
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
function routeFor(routes: Route[], userId?: string, tz?: string | null): Route | null {
  const today = dayKey(Date.now(), tz)
  const todays = routes.filter((r) => r.date === today)
  const pool = todays.length ? todays : routes
  /*
    The second line used to look for the demo's first rep by id, which reached
    into `data/seed` from a path that runs against real accounts. It never
    changed the outcome — a live route pool contains no demo id, so it always
    fell through to `pool[0]` — but a live read of a demo identifier is the
    kind of thing that stops being harmless the moment somebody reuses the
    constant. `pool[0]` was always what it meant.
  */
  return pool.find((r) => r.repId === userId) ?? pool[0] ?? null
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

/**
 * The property ids this person may see, from a state snapshot.
 *
 * Not a hook: the store's own actions need the answer synchronously to decide
 * what a rep may put on a list. The predicate is `canSee`, the same one the
 * server applies, so a house that gets onto a list here is a house the server
 * will accept.
 */
function useScopedIds(state: Pick<AppState, 'properties' | 'leadLists' | 'user'>): string[] {
  const all = Object.values(state.properties)
  if (!isRep(state.user)) return all.map((p) => p.id)
  const via = leadIdsViaLists(state.user!, Object.values(state.leadLists))
  return all.filter((p) => canSee(p, state.user, via)).map((p) => p.id)
}

/**
 * A rep sees the houses assigned to them — and, since lead lists, the houses on
 * any live list handed to them. Same rule as the server's bootstrap, stated in
 * `src/lib/leadLists.ts` and gated by `verify:leadlists`; a difference between
 * the two is a house that vanishes on refresh or a list that is one short.
 */
export function useScopedProperties(): Property[] {
  const properties = useAppStore((s) => s.properties)
  const leadLists = useAppStore((s) => s.leadLists)
  const user = useAppStore((s) => s.user)
  return useMemo(() => {
    const all = Object.values(properties)
    if (!isRep(user)) return all
    const via = leadIdsViaLists(user!, Object.values(leadLists))
    return all.filter((p) => canSee(p, user, via))
  }, [properties, leadLists, user])
}

/**
 * A rep id as a person, from whichever list this phone has.
 *
 * The office's roster first, then the names-only one bootstrap sends a rep,
 * then the signed-in user themselves — a rep looking at their own house should
 * read their own name, not their id. `undefined` when nobody by that id is
 * known, so the caller can say "somebody who has left" rather than print a hash.
 */
export function useRepName(id: string | undefined): string | undefined {
  const team = useAppStore((s) => s.team)
  const roster = useAppStore((s) => s.roster)
  const user = useAppStore((s) => s.user)
  if (!id) return undefined
  return team.find((m) => m.id === id)?.name ?? roster.find((m) => m.id === id)?.name ?? (user?.id === id ? user.name : undefined)
}

/** The lists this person works — handed to them or made by them. Live only. */
export function useMyLists(): LeadList[] {
  const leadLists = useAppStore((s) => s.leadLists)
  const user = useAppStore((s) => s.user)
  return useMemo(
    () => listsFor(user, Object.values(leadLists)).sort((a, b) => a.name.localeCompare(b.name)),
    [leadLists, user],
  )
}

/** The live lists a lead is on, for the peek and the profile. */
export function useListsContaining(propertyId: string | undefined): LeadList[] {
  const leadLists = useAppStore((s) => s.leadLists)
  return useMemo(
    () => (propertyId ? listsContaining(propertyId, Object.values(leadLists)) : []),
    [leadLists, propertyId],
  )
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
