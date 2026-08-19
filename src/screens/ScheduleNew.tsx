import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { Card, SectionHeader } from '../components/ui/Card'
import { Field } from '../components/ui/Input'
import { useAppStore } from '../store/useAppStore'
import { distanceMiles } from '../lib/geo'
import { haptic } from '../lib/haptics'
import { time } from '../lib/format'
import { IconSearch } from '../components/nav/icons'

/**
 * Schedule an appointment.
 *
 * Property first, then day, then time — chosen from big preset targets rather
 * than a native picker wheel, which is slow and fiddly one-handed. The picker
 * is still there for anything the presets don't cover.
 */
export function ScheduleNew() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const { properties, position, createAppointment } = useAppStore()

  const [propertyId, setPropertyId] = useState(params.get('property') ?? '')
  const [query, setQuery] = useState('')
  const [when, setWhen] = useState<number>(() => defaultSlot())
  const [title, setTitle] = useState('Estimate appointment')
  const [duration, setDuration] = useState(45)
  const [saving, setSaving] = useState(false)

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = Object.values(properties)
    if (q) {
      rows = rows.filter(
        (p) =>
          p.address1.toLowerCase().includes(q) ||
          p.contacts.some((c) => c.name.toLowerCase().includes(q)),
      )
    } else if (position) {
      rows = [...rows]
        .sort((a, b) => distanceMiles(position, a) - distanceMiles(position, b))
    }
    return rows.slice(0, 12)
  }, [properties, query, position])

  const selected = propertyId ? properties[propertyId] : undefined

  const save = async () => {
    if (!selected) return
    setSaving(true)
    haptic('confirm')
    await createAppointment({
      propertyId: selected.id,
      startsAt: when,
      durationMin: duration,
      title,
      contactId: selected.contacts[0]?.id,
    })
    nav(`/property/${selected.id}`, { replace: true })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="New appointment" back />

      <div className="scroll-pane bg-surface-sunk">
        <div className="content-col page anim-rise">
        {/* --- property --------------------------------------------------- */}
        <Card>
          <SectionHeader title="Property" className="mb-3" />
          {selected ? (
            <div className="flex items-center gap-3 rounded-field bg-surface-warm py-2 pl-3.5 pr-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">{selected.address1}</p>
                <p className="truncate text-[13px] text-ink-mute">
                  {selected.contacts[0]?.name ?? 'No contact'}
                </p>
              </div>
              <button
                onClick={() => setPropertyId('')}
                className="focusable min-h-tap shrink-0 rounded-field px-3 text-[14px] font-semibold text-brand-600"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <label className="relative block">
                <span className="sr-only">Search properties</span>
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-mute">
                  <IconSearch />
                </span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  type="search"
                  placeholder="Search address or name"
                  className="field h-[52px] pl-11 pr-3"
                />
              </label>
              <ul className="row-group mt-1 max-h-72 overflow-y-auto">
                {candidates.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => setPropertyId(p.id)}
                      className="flex min-h-[58px] w-full items-center px-1 text-left active:bg-surface-field"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[15px] font-medium">
                          {p.address1}
                        </span>
                        <span className="block truncate text-[13px] text-ink-mute">
                          {p.contacts[0]?.name ?? 'No contact'}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        {/* --- when ------------------------------------------------------- */}
        <Card>
          <SectionHeader title="When" className="mb-3" />
          <div className="grid grid-cols-2 gap-2.5">
            {slots().map((s) => (
              <button
                key={s.at}
                onClick={() => {
                  haptic('tap')
                  setWhen(s.at)
                }}
                aria-pressed={when === s.at}
                className={`press focusable min-h-[60px] rounded-field px-2 text-[14px] font-semibold transition-colors ${
                  when === s.at
                    ? 'bg-brand-50 text-brand-700 ring-2 ring-brand-500'
                    : 'bg-surface text-ink ring-1 ring-ink/10 active:bg-surface-field'
                }`}
              >
                {s.label}
                <span className="nums mt-0.5 block text-[12.5px] font-medium text-ink-mute">
                  {time(s.at)}
                </span>
              </button>
            ))}
          </div>
          <label className="mt-4 block">
            <span className="eyebrow">Or pick exactly</span>
            <input
              type="datetime-local"
              value={toLocalInput(when)}
              onChange={(e) => e.target.value && setWhen(new Date(e.target.value).getTime())}
              className="field mt-1.5 h-[52px]"
            />
          </label>
        </Card>

        {/* --- details ---------------------------------------------------- */}
        <Card className="space-y-4">
          <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink">Length</span>
            <div className="flex gap-2">
              {[30, 45, 60, 90].map((m) => (
                <button
                  key={m}
                  onClick={() => setDuration(m)}
                  aria-pressed={duration === m}
                  className={`press focusable min-h-[52px] flex-1 rounded-field text-[14px] font-semibold transition-colors ${
                    duration === m
                      ? 'bg-brand-50 text-brand-700 ring-2 ring-brand-500'
                      : 'bg-surface text-ink ring-1 ring-ink/10 active:bg-surface-field'
                  }`}
                >
                  {m}m
                </button>
              ))}
            </div>
          </div>
        </Card>
        </div>
      </div>

      <div
        className="shrink-0 bg-surface px-4 pt-3.5 shadow-nav"
        style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
      >
        <Button size="lg" full onClick={() => void save()} disabled={!selected || saving}>
          {saving ? 'Saving…' : 'Create appointment'}
        </Button>
      </div>
    </div>
  )
}

function defaultSlot(): number {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(10, 0, 0, 0)
  return d.getTime()
}

function slots(): { label: string; at: number }[] {
  const mk = (days: number, hour: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }
  return [
    { label: 'Today', at: mk(0, 18) },
    { label: 'Tomorrow AM', at: mk(1, 10) },
    { label: 'Tomorrow PM', at: mk(1, 15) },
    { label: 'This weekend', at: mk(daysUntilSaturday(), 11) },
  ]
}

function daysUntilSaturday(): number {
  const today = new Date().getDay()
  return (6 - today + 7) % 7 || 7
}

function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}
