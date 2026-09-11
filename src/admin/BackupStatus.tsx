import { useEffect, useState } from 'react'
import { IconCheck, IconClose, IconWarn } from '../components/nav/icons'
import { apiLatestBackup, type BackupEvidenceDTO } from '../lib/http'
import { backupState, type BackupTone } from '../lib/backupState'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'

/**
 * Did last night's backup actually happen?
 *
 * `/api/health` has reported `backupBucket` and `backupKey` for a while, and
 * that pair answers a different question from the one anybody asks. It says the
 * configuration is present. A cron that stopped firing, a `put` that threw every
 * night, a bucket somebody emptied — all three leave both flags `true` forever,
 * and this project has already read `backupKey: true` beside a log line saying
 * no backup was taken, and had to work out which of the two was stale.
 *
 * So this shows evidence rather than configuration: the newest object in the
 * bucket, its size, and how long ago it landed. The age is the point. "Nine
 * hours ago" and "nineteen days ago" are different facts, and presence cannot
 * tell them apart.
 *
 * Super admin only, and on the platform screen rather than a company's, because
 * the dump is the whole database — every customer's — and its size over time
 * describes that database. The server enforces the role; this component does not
 * check a second time, for the reason written at the top of `AdminClients`.
 *
 * Which of the five things to say lives in `lib/backupState`, not here. It is a
 * ranking and a threshold, both of which get quietly wrong, and neither needs a
 * browser to be checked.
 */

const TONE: Record<BackupTone, string> = {
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  mute: 'text-ink-mute',
}

const MARK: Record<BackupTone, () => React.JSX.Element> = {
  good: IconCheck,
  warn: IconWarn,
  bad: IconClose,
  mute: IconWarn,
}

export function BackupStatus() {
  const mode = useAppStore((s) => s.mode)
  const [data, setData] = useState<BackupEvidenceDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (mode === 'demo') {
      setLoading(false)
      return
    }
    const t = liveToken()
    if (!t) {
      setLoading(false)
      return
    }
    let live = true
    void apiLatestBackup(t)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not read the bucket.'))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [mode])

  const state = backupState(
    mode === 'demo'
      ? { kind: 'demo' }
      : error
        ? { kind: 'error', message: error }
        : data
          ? { kind: 'evidence', data }
          : { kind: 'no-session' },
    Date.now(),
  )

  const Mark = MARK[state.tone]

  return (
    <section className="mt-4 card p-5" data-testid="backup-status">
      <h2 className="text-sm font-bold">Database backups</h2>
      {loading && mode !== 'demo' ? (
        <p className="mt-2 text-[15px] text-ink-mute">Reading the backup bucket…</p>
      ) : (
        <div className="mt-2 flex gap-3">
          <span className={`mt-0.5 shrink-0 icon-sm ${TONE[state.tone]}`} aria-hidden>
            <Mark />
          </span>
          <div className="min-w-0">
            <p
              className={`text-[15px] font-medium ${TONE[state.tone]}`}
              data-testid="backup-headline"
            >
              {state.headline}
            </p>
            <p className="mt-0.5 break-all text-xs leading-relaxed text-ink-mute">{state.detail}</p>
            {data?.latest && (
              <p className="mt-1 text-xs text-ink-mute">
                {data.seen}
                {data.scanCapped ? '+' : ''} backup{data.seen === 1 ? '' : 's'} in the bucket.
              </p>
            )}
          </div>
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-ink-mute">
        Read from the bucket rather than from the settings, because a secret being set
        and a backup being taken are different facts — and the first stays true after
        the second stops.
      </p>
    </section>
  )
}
