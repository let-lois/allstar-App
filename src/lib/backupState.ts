import type { BackupEvidenceDTO } from './http'

/**
 * What the backup panel should say, as a decision rather than as markup.
 *
 * In a `.ts` and free of React on purpose. The interesting part of this feature
 * is not the card — it is the ranking of five situations that look identical
 * from `/api/health`, and one threshold. Both are exactly the kind of thing that
 * gets a branch wrong silently, and neither needs a browser to check, so they
 * live where a Node gate can import them through type stripping.
 *
 * The ordering matters and is the whole point. "Configured" must not outrank
 * "configured and the bucket is empty", because the second is what a cron that
 * stopped firing looks like — and the first is the sentence `/api/health` has
 * been saying, truthfully, the entire time.
 */

/** Older than this and the nightly job has missed at least one run. */
export const STALE_HOURS = 36

export type BackupTone = 'good' | 'warn' | 'bad' | 'mute'

export interface BackupState {
  tone: BackupTone
  headline: string
  detail: string
}

export function backupState(
  input:
    | { kind: 'demo' }
    | { kind: 'no-session' }
    | { kind: 'error'; message: string }
    | { kind: 'evidence'; data: BackupEvidenceDTO },
  now: number,
): BackupState {
  if (input.kind === 'demo') {
    return {
      tone: 'mute',
      headline: 'No server database in the demo',
      detail:
        'The demo runs entirely on this device. On a live account this says when the last backup landed and how big it was.',
    }
  }

  if (input.kind === 'no-session') {
    return {
      tone: 'mute',
      headline: 'Not signed in to a live account',
      detail: 'Backups are a server fact, so this needs a live session to read.',
    }
  }

  if (input.kind === 'error') {
    return {
      tone: 'bad',
      headline: 'Could not read the backup bucket',
      detail: input.message,
    }
  }

  const { data } = input

  if (!data.configured) {
    return {
      tone: 'bad',
      headline: 'No backups are being taken',
      detail: data.reason ?? 'The nightly job is not configured.',
    }
  }

  /*
    Configured, and nothing in the bucket. Deliberately ranked above the happy
    path rather than folded into it: this is a cron that never fired or a `put`
    that throws every night, and it is the exact state that reports
    `backupKey: true` forever.
  */
  if (!data.latest) {
    return {
      tone: 'bad',
      headline: 'Configured, but the bucket is empty',
      detail:
        'The secret and the bucket are both set and nothing has ever been written. The nightly job is not running, or it is failing before the upload.',
    }
  }

  const hours = (now - data.latest.uploadedAt) / 3_600_000
  const stale = hours > STALE_HOURS
  return {
    tone: stale ? 'warn' : 'good',
    headline: stale
      ? `Last backup ${ago(hours)} — at least one night was missed`
      : `Last backup ${ago(hours)}`,
    detail: `${size(data.latest.bytes)} · ${data.latest.key}`,
  }
}

/**
 * How long ago, in the largest unit that still says something.
 *
 * Minutes under an hour, hours to two days, then days. A backup taken nineteen
 * days ago reported as "456 hours ago" is a number somebody has to divide before
 * they can be alarmed by it.
 */
export function ago(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`
  if (hours < 48) return `${Math.round(hours)} hours ago`
  return `${Math.round(hours / 24)} days ago`
}

export function size(bytes: number): string {
  return bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`
}
