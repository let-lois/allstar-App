export interface Env {
  DB: D1Database
  PHOTOS: R2Bucket
  ALLOWED_ORIGINS: string
  SESSION_PEPPER?: string
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
