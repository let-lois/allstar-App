import { useEffect, useState } from 'react'
import { drain, getSyncSnapshot, subscribeSync, type SyncSnapshot } from '../../lib/sync'
import { relativeLower } from '../../lib/format'

export function useSync(): SyncSnapshot {
  const [snap, setSnap] = useState<SyncSnapshot>(getSyncSnapshot)
  useEffect(() => subscribeSync(setSnap), [])
  return snap
}

const TONE = {
  synced: { dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', label: 'Synced' },
  syncing: { dot: 'bg-brand-500', text: 'text-brand-700', bg: 'bg-brand-50', label: 'Syncing' },
  pending: { dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', label: 'Pending' },
  offline: { dot: 'bg-slate-400', text: 'text-slate-700', bg: 'bg-slate-100', label: 'Offline' },
  error: { dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', label: 'Sync failed' },
} as const

/**
 * Persistent sync chip.
 *
 * A rep who isn't sure whether a visit saved will re-enter it, and re-entered
 * visits corrupt the numbers a manager is paid on. So the state is always on
 * screen — never a toast that scrolls away.
 */
export function SyncBadge({ onClick }: { onClick?: () => void }) {
  const snap = useSync()
  const tone = TONE[snap.state]
  const count = snap.state === 'error' ? snap.failed : snap.pending

  return (
    <button
      onClick={onClick}
      aria-label={`Sync status: ${tone.label}${count ? `, ${count} waiting` : ''}`}
      className={`focusable inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-xs font-semibold ${tone.bg} ${tone.text}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${tone.dot} ${snap.state === 'syncing' ? 'animate-pulse' : ''}`}
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
      <div className={`flex items-center gap-3 rounded-2xl p-4 ${tone.bg}`}>
        <span className={`h-3 w-3 rounded-full ${tone.dot}`} />
        <div className="min-w-0 flex-1">
          <p className={`font-semibold ${tone.text}`}>{tone.label}</p>
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
          className="focusable min-h-tap w-full rounded-xl border border-slate-200 font-medium active:bg-slate-50"
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
      <span className="h-2 w-2 shrink-0 rounded-full bg-slate-400" />
      Working offline — {snap.pending} change{snap.pending === 1 ? '' : 's'} saved on this
      phone
    </div>
  )
}
