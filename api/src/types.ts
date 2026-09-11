export interface Env {
  DB: D1Database
  /**
   * Optional. R2 needs a payment method to activate, so a prototype deployment
   * runs without it: photo metadata still syncs, the image stays on the phone.
   */
  PHOTOS?: R2Bucket
  /**
   * Where scheduled database backups go. Optional, and deliberately NOT the
   * photos bucket: a dump holds every customer's addresses, contact names,
   * phone numbers and password hashes, and it should not sit in the same place
   * as the files a rep's phone uploads over a normal API call. Different
   * contents, different blast radius, different bucket.
   *
   * Absent means no backup is taken. That is reported by `/api/health` and
   * shouted into the log on every scheduled run, because a backup that has
   * never happened looks exactly like one that happens every night.
   */
  BACKUPS?: R2Bucket
  /**
   * Encrypts those backups. Optional, and its absence is a refusal rather than
   * a fallback — the Worker will not write a dump in the clear.
   *
   * Use the SAME value as the operator's local `api/.backup-key`. The two are
   * interchangeable only if they match, and `npm run backup:open` /
   * `verify-restore` then read a file from either source with no flag. Losing
   * it is unrecoverable: every backup written with it becomes permanently
   * unreadable, so keep old keys forever rather than rotating them.
   */
  BACKUP_KEY?: string
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
   * Points the free Census geocoder at a stand-in, so the inbound path can be
   * exercised end to end. Unset in every real deployment.
   */
  CENSUS_BASE_URL?: string
  /*
   * The same, for Google — so a revoked or over-quota key, which answers
   * REQUEST_DENIED to everything, can be driven against a stand-in. That
   * failure degrades silently by design and is the one worth a gate. Unset in
   * every real deployment.
   */
  GOOGLE_GEOCODE_BASE_URL?: string
  /*
   * Encrypts third-party credentials at rest — see secretbox.ts.
   *
   * Optional, and its absence is a refusal rather than a fallback: with no key
   * set, connecting a CRM fails with an explanation instead of quietly storing
   * the customer's token in plaintext. Rotating it makes stored tokens
   * unreadable and every connected company has to reconnect, which is
   * unpleasant and visible — unlike SESSION_PEPPER, it is survivable.
   */
  INTEGRATION_KEY?: string
  /** Overrides where GoHighLevel calls go. See `baseFor` in ghl.ts. */
  GHL_BASE_URL?: string
  /*
   * Outbound email — invitations. Both secrets; see mail.ts. With either
   * missing nothing is sent and the console hands the admin a link instead,
   * which is what it did before email existed.
   */
  MAILCHANNELS_API_KEY?: string
  /** `Allstar <no-reply@yourdomain.com>` — the domain carrying the DNS records. */
  MAIL_FROM?: string
  /** Points the mail API at a stand-in in tests. Unset in every real deployment. */
  MAIL_BASE_URL?: string
}

export type Role = 'super_admin' | 'client_admin' | 'manager' | 'field_rep'

export interface SessionUser {
  id: string
  clientId: string
  clientName: string
  /**
   * The company's IANA timezone — the calendar its reporting days are cut on.
   *
   * On the session rather than fetched where it is needed: every query that
   * resolves a session already joins `clients`, so it rides along for free, and
   * the alternative is an extra lookup inside the write path of every visit.
   */
  timezone: string
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

/**
 * `obsolete` is not a failure. The mutation was well-formed and the rep was
 * entitled to make it — its target was erased while it sat in the outbox, so
 * there is nothing left to apply it to. The phone must drop it rather than
 * retry it, which is why this is a status of its own and not a rejection.
 */
export type MutationOutcome = 'applied' | 'duplicate' | 'rejected' | 'obsolete'

export interface MutationResult {
  id: string
  status: MutationOutcome
  error?: string
}
