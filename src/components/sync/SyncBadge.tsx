import { useEffect, useState } from 'react'
import { drain, getSyncSnapshot, subscribeSync, type SyncSnapshot } from '../../lib/sync'
import { relativeLower } from '../../lib/format'

export function useSync(): SyncSnapshot {
  const [snap, setSnap] = useState<SyncSnapshot>(getSyncSnapshot)
  useEffect(() => subscribeSync(setSnap), [])
  return snap
}

const TONE = {
  synced: { dot: 'bg-good', text: 'text-good', bg: 'bg-good-bg', label: 'Synced' },
  syncing: { dot: 'bg-brand-400', text: 'text-accent-strong', bg: 'bg-surface-tint', label: 'Syncing' },
  pending: { dot: 'bg-warn', text: 'text-warn', bg: 'bg-warn-bg', label: 'Pending' },
  offline: { dot: 'bg-ink-faint', text: 'text-ink-soft', bg: 'bg-surface-field', label: 'Offline' },
  error: { dot: 'bg-bad', text: 'text-bad', bg: 'bg-bad-bg', label: 'Sync failed' },
} as const

/**
 * Persistent sync chip.
 *
 * A rep who isn't sure whether a visit saved will re-enter it, and re-entered
 * visits corrupt the numbers a manager is paid on. So the state is always on
 * screen — never a toast that scrolls away.
 *
 * **Sized for what it usually says, which is nothing interesting.** It used to be
 * a filled pill, and in the state it is in ninety-nine percent of the time —
 * synced, nothing waiting — a green block was the loudest element in the header,
 * shouting that everything was normal. Now the resting state is a dot and a word
 * in grey: findable, ignorable.
 *
 * The tinted pill comes back the moment there is something to say. Pending,
 * offline and failed keep their fill and their colour, because those are the
 * states worth interrupting someone for. The tap target stays 44px either way —
 * it is quieter, not smaller.
 */
export function SyncBadge({ onClick }: { onClick?: () => void }) {
  const snap = useSync()
  const tone = TONE[snap.state]
  const count = snap.state === 'error' ? snap.failed : snap.pending
  const quiet = snap.state === 'synced'

  return (
    <button
      onClick={onClick}
      aria-label={`Sync status: ${tone.label}${count ? `, ${count} waiting` : ''}`}
      className={[
        'focusable inline-flex min-h-[44px] items-center gap-1.5 rounded-full text-[12.5px] font-medium',
        quiet ? 'px-1 text-ink-mute' : `px-3 font-semibold ${tone.bg} ${tone.text}`,
      ].join(' ')}
    >
      <span
        className={`h-[7px] w-[7px] rounded-full ${tone.dot} ${snap.state === 'syncing' ? 'animate-pulse' : ''}`}
      />
      <span>{tone.label}</span>
      {count > 0 && <span className="nums opacity-80">{count}</span>}
    </button>
  )
}

/** Expanded panel — what's waiting, why, and a way to force a retry. */
export function SyncDetail() {
  const snap = useSync()
  const tone = TONE[snap.state]

  return (
    <div className="space-y-3">
      <div
        className={`flex items-center gap-3 rounded-card p-4 ${
          snap.state === 'synced' ? 'bg-surface-field' : tone.bg
        }`}
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} />
        <div className="min-w-0 flex-1">
          <p className={`font-semibold ${snap.state === 'synced' ? 'text-ink' : tone.text}`}>
            {tone.label}
          </p>
          <p className="text-xs text-ink-mute">
            {snap.state === 'offline'
              ? 'Your work is saved on this phone and will upload automatically.'
              : snap.state === 'error'
                ? `${snap.failed} item${snap.failed === 1 ? '' : 's'} could not upload.`
                : snap.pending > 0
                  ? `${snap.pending} item${snap.pending === 1 ? '' : 's'} waiting to upload.`
                  : `Everything is uploaded. Last sync ${relativeLower(snap.lastSyncedAt)}.`}
          </p>
        </div>
      </div>

      <p className="px-1 text-xs leading-relaxed text-ink-mute">
        Visits, outcomes, notes and photos are written to this device first. Nothing is
        lost if you go out of coverage — it uploads the moment signal returns.
      </p>

      {(snap.pending > 0 || snap.failed > 0) && (
        <button
          onClick={() => void drain()}
          className="focusable min-h-tap w-full rounded-field border border-line font-medium active:bg-surface-field"
        >
          Try now
        </button>
      )}
    </div>
  )
}

/**
 * Full-width banner shown only when offline. Deliberately reassuring rather than
 * alarming — going offline is a normal state in this job, not an error.
 */
export function OfflineBanner() {
  const snap = useSync()
  if (snap.state !== 'offline') return null
  return (
    <div className="flex items-center gap-2 bg-ink px-4 py-1.5 text-xs font-medium text-white">
      <span className="h-2 w-2 shrink-0 rounded-full bg-ink-faint" />
      Working offline — {snap.pending} change{snap.pending === 1 ? '' : 's'} saved on this
      phone
    </div>
  )
}
