export interface Env {
  DB: D1Database
  /**
   * Optional. R2 needs a payment method to activate, so a prototype deployment
   * runs without it: photo metadata still syncs, the image stays on the phone.
   */
  PHOTOS?: R2Bucket
  ALLOWED_ORIGINS: string
  SESSION_PEPPER?: string
  /** Present only while first-run setup is still needed; remove after. */
  SETUP_TOKEN?: string
  /** Where the front end lives, for links on the Worker-served pages. */
  APP_URL?: string
  /**
   * Optional. Present means addresses are geocoded to the rooftop via Google;
   * absent means the free Census geocoder, which places a house on the right
   * block. Everything works either way — the difference is precision.
   */
  GOOGLE_MAPS_API_KEY?: string
  /*
   * Separate from the client's VITE_MAPTILER_KEY on purpose. That one is
   * compiled into the bundle and locked to the site's origin, which a Worker
   * request does not carry — so it would be rejected here. This is a second key
   * with no origin restriction, which is why it has to live as a secret.
   */
  MAPTILER_API_KEY?: string
}

export type Role = 'super_admin' | 'client_admin' | 'manager' | 'field_rep'

export interface SessionUser {
  id: string
  clientId: string
  clientName: string
  email: string
  name: string
  role: Role
  phone?: string
}

/** Mirrors the client's outbox rows — the wire format is the client's, not ours. */
export interface Mutation {
  id: string
  kind: string
  payload: unknown
  createdAt: number
}

export type MutationOutcome = 'applied' | 'duplicate' | 'rejected'

export interface MutationResult {
  id: string
  status: MutationOutcome
  error?: string
}
