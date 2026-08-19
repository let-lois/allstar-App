import { useMemo, useRef, useState } from 'react'
import { AdminPage } from './AdminLayout'
import { Button } from '../components/ui/Button'
import {
  FILE_PROBLEM_MESSAGE,
  IMPORT_FIELDS,
  autoMap,
  parseCsv,
  sniffFile,
  type ImportField,
  type Row,
} from '../lib/csv'
import {
  ApiError,
  apiGeocode,
  apiImport,
  apiUsers,
  type ImportResultDTO,
  type TeamUserDTO,
} from '../lib/http'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'

/**
 * Lead import.
 *
 * A tenant starts empty, and the app's whole premise — a route, a map, a day
 * planned before the rep leaves the truck — needs addresses before any of it
 * means anything. This is the only screen in the product where the operator
 * genuinely is sitting at a desk with a spreadsheet, which is why it's in the
 * console and shaped like a wizard rather than a form.
 *
 * The sequencing is deliberate: **nothing is written until the operator has seen
 * what will be written.** An import is the one action here that's tedious to
 * undo — five hundred wrong rows have to be found and deleted by hand — so the
 * mapping is shown, the preview is real, and the geocoding happens before the
 * write rather than during it.
 */

type Stage = 'pick' | 'map' | 'review' | 'done'

interface PreparedRow {
  ref: string
  values: Partial<Record<ImportField, string>>
  lat?: number
  lng?: number
  /** Set when the geocoder was asked and couldn't place it. */
  geocodeStatus?: 'match' | 'no_match' | 'tie' | 'error'
  matchedAddress?: string
  /** How precisely it was placed — the thing rooftop geocoding is paid for. */
  precision?: 'rooftop' | 'interpolated' | 'approximate'
  /** The geocoder answered a misspelled address by guessing at it. */
  partial?: boolean
}

const SAMPLE = `address,city,state,zip,owner,phone
1420 Cedar Bend Dr,Round Rock,TX,78664,Dana Whitfield,512-555-0134
1422 Cedar Bend Dr,Round Rock,TX,78664,,
1424 Cedar Bend Dr,Round Rock,TX,78664,Marcus Vance,512-555-0199`

export default function AdminImport() {
  const mode = useAppStore((s) => s.mode)
  const refreshFromServer = useAppStore((s) => s.refreshFromServer)

  const [stage, setStage] = useState<Stage>('pick')
  const [raw, setRaw] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [ragged, setRagged] = useState(0)
  const [mapping, setMapping] = useState<Partial<Record<ImportField, string>>>({})
  const [prepared, setPrepared] = useState<PreparedRow[]>([])

  const [reps, setReps] = useState<TeamUserDTO[]>([])
  const [assignRepId, setAssignRepId] = useState('')
  const [territoryName, setTerritoryName] = useState('')

  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResultDTO | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)

  /* --- stage 1: get the text ------------------------------------------- */

  function load(text: string) {
    const parsed = parseCsv(text)
    if (parsed.rows.length === 0) {
      setError('No rows found in that file. Is the first line a header?')
      return
    }
    setError(null)
    setRaw(text)
    setHeaders(parsed.headers)
    setRows(parsed.rows)
    setRagged(parsed.ragged)
    setMapping(autoMap(parsed.headers))
    setStage('map')
  }

  async function onFile(file: File) {
    // Read the bytes, not `file.text()`. A shortcut, a workbook or a PDF all
    // decode to *something*, and the parser will happily find a header row in
    // the mojibake — the operator then gets a column mapper full of garbage and
    // no idea whether the fault is theirs or the app's.
    const bytes = new Uint8Array(await file.arrayBuffer())
    const { problem, text } = sniffFile(bytes)
    if (problem !== 'ok' || text == null) {
      setError(`${file.name}: ${FILE_PROBLEM_MESSAGE[problem as Exclude<typeof problem, 'ok'>]}`)
      setStage('pick')
      return
    }
    load(text)
  }

  /* --- stage 2 → 3: apply the mapping --------------------------------- */

  function prepare() {
    const out: PreparedRow[] = rows.map((row, i) => {
      const values: Partial<Record<ImportField, string>> = {}
      for (const { key } of IMPORT_FIELDS) {
        const col = mapping[key]
        if (col && row[col]) values[key] = row[col]
      }
      const lat = num(values.lat)
      const lng = num(values.lng)
      return {
        // Line 2 is the first data row in the file the operator is looking at.
        ref: `L${i + 2}`,
        values,
        lat: validCoord(lat, 90) ? lat : undefined,
        lng: validCoord(lng, 180) ? lng : undefined,
      }
    })
    setPrepared(out)
    setStage('review')
    // The rep dropdown is only needed from here on, and only in live mode.
    if (mode === 'live') void loadReps()
  }

  async function loadReps() {
    const token = liveToken()
    if (!token) return
    try {
      const { users } = await apiUsers(token)
      setReps(users.filter((u) => u.active))
    } catch {
      // Not fatal — assignment is optional, and leads can be assigned later.
    }
  }

  /* --- geocoding ------------------------------------------------------- */

  const needsGeocode = useMemo(
    () => prepared.filter((r) => r.values.address1 && (r.lat == null || r.lng == null)),
    [prepared],
  )

  async function runGeocode() {
    const token = liveToken()
    if (!token) {
      setError('Address lookup needs a live account. Sign in with real credentials to import.')
      return
    }
    setBusy('geocode')
    setError(null)
    setProgress({ done: 0, total: needsGeocode.length })

    const byRef = new Map(prepared.map((r) => [r.ref, r]))
    // Matches GEOCODE_CHUNK on the server; the larger of the two gets a 413.
    // Sized for Google, which has no batch endpoint — one request per address
    // against a Worker's subrequest budget.
    const CHUNK = 40
    try {
      for (let i = 0; i < needsGeocode.length; i += CHUNK) {
        const chunk = needsGeocode.slice(i, i + CHUNK)
        const { matches } = await apiGeocode(
          token,
          chunk.map((r) => ({
            ref: r.ref,
            address1: r.values.address1 ?? '',
            city: r.values.city,
            state: r.values.state,
            zip: r.values.zip,
          })),
        )
        for (const m of matches) {
          const row = byRef.get(m.ref)
          if (!row) continue
          row.geocodeStatus = m.status
          if (m.status === 'match') {
            row.lat = m.lat
            row.lng = m.lng
            row.matchedAddress = m.matchedAddress
            row.precision = m.precision
            row.partial = m.partial
          }
        }
        setProgress({ done: Math.min(i + CHUNK, needsGeocode.length), total: needsGeocode.length })
        // New array identity so React re-renders the table.
        setPrepared([...byRef.values()])
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Address lookup failed. Rows that were placed are kept — you can run it again.',
      )
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  /* --- the write ------------------------------------------------------- */

  const importable = useMemo(
    () => prepared.filter((r) => r.values.address1 && r.lat != null && r.lng != null),
    [prepared],
  )
  const unplaced = useMemo(
    () => prepared.filter((r) => r.values.address1 && (r.lat == null || r.lng == null)),
    [prepared],
  )
  const noAddress = useMemo(() => prepared.filter((r) => !r.values.address1), [prepared])

  async function runImport() {
    const token = liveToken()
    if (!token) {
      setError('Importing needs a live account. Sign in with real credentials.')
      return
    }
    setBusy('import')
    setError(null)

    // Chunked to the server's per-request ceiling; the totals are summed so the
    // operator sees one number rather than one per chunk.
    const CHUNK = 500
    const totals: ImportResultDTO = { created: 0, updated: 0, rejected: [] }
    setProgress({ done: 0, total: importable.length })

    try {
      for (let i = 0; i < importable.length; i += CHUNK) {
        const chunk = importable.slice(i, i + CHUNK)
        const res = await apiImport(token, {
          rows: chunk.map((r) => ({
            ref: r.ref,
            address1: r.values.address1 ?? '',
            city: r.values.city,
            state: r.values.state,
            zip: r.values.zip,
            lat: r.lat,
            lng: r.lng,
            ownerName: r.values.ownerName,
            phone: r.values.phone,
            email: r.values.email,
            opportunityValue: num(r.values.opportunityValue),
            roofAgeYears: num(r.values.roofAgeYears),
            squareFeet: num(r.values.squareFeet),
          })),
          assignRepId: assignRepId || undefined,
          territoryName: territoryName.trim() || undefined,
        })
        totals.created += res.created
        totals.updated += res.updated
        totals.rejected.push(...res.rejected)
        totals.territoryId ??= res.territoryId
        setProgress({ done: Math.min(i + CHUNK, importable.length), total: importable.length })
      }
      setResult(totals)
      setStage('done')
      // Pull the new leads into the console's own view of the world.
      await refreshFromServer()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import failed. Nothing was lost — try again.')
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  function reset() {
    setStage('pick')
    setRaw('')
    setHeaders([])
    setRows([])
    setPrepared([])
    setResult(null)
    setError(null)
    setRagged(0)
  }

  /* --- render ---------------------------------------------------------- */

  return (
    <AdminPage
      title="Import leads"
      description="Turn a list of addresses into properties your reps can work."
      actions={
        stage !== 'pick' && (
          <Button variant="secondary" onClick={reset}>
            Start over
          </Button>
        )
      }
    >
      {mode === 'demo' && (
        <div className="mb-4 rounded-field bg-warn-bg p-4 text-sm text-warn ring-1 ring-warn/25">
          <p className="font-semibold">You’re in the demo.</p>
          <p className="mt-1 leading-relaxed">
            You can load a file and check the column mapping and preview here, but
            address lookup and importing write to a real database and need a live
            account. Sign out and sign in with your credentials to import.
          </p>
        </div>
      )}

      <Steps stage={stage} />

      {error && (
        <p role="alert" className="mb-4 rounded-field bg-bad-bg p-3 text-sm font-medium text-bad ring-1 ring-bad/25">
          {error}
        </p>
      )}

      {/* ---- 1. pick a file --------------------------------------------- */}
      {stage === 'pick' && (
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <section className="card p-5">
            <h2 className="font-bold">Choose a file</h2>
            <p className="mt-1 text-sm text-ink-mute">
              CSV or a tab-separated export. The first row must be column headers.
            </p>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files[0]
                if (f) void onFile(f)
              }}
              className="mt-4 grid place-items-center rounded-field border-2 border-dashed border-ink/15 bg-surface-sunk p-8 text-center"
            >
              <p className="text-sm text-ink-mute">Drag a file here</p>
              <Button variant="secondary" className="mt-3" onClick={() => fileInput.current?.click()}>
                Choose file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void onFile(f)
                }}
              />
            </div>
          </section>

          <section className="card p-5">
            <h2 className="font-bold">Or paste it</h2>
            <p className="mt-1 text-sm text-ink-mute">
              Copy the rows straight out of a spreadsheet, headers included.
            </p>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={7}
              spellCheck={false}
              placeholder={SAMPLE}
              className="focusable mt-3 w-full rounded-field border border-ink/15 p-3 font-mono text-xs"
            />
            <div className="mt-3 flex gap-2">
              <Button onClick={() => load(raw)} disabled={!raw.trim()}>
                Continue
              </Button>
              <Button variant="secondary" onClick={() => setRaw(SAMPLE)}>
                Use a sample
              </Button>
            </div>
          </section>
        </div>
      )}

      {/* ---- 2. map the columns ---------------------------------------- */}
      {stage === 'map' && (
        <section className="card p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-bold">Check the columns</h2>
              <p className="mt-1 text-sm text-ink-mute">
                {rows.length.toLocaleString()} rows found. We’ve guessed the mapping —
                correct anything that’s wrong before continuing.
              </p>
            </div>
            <Button onClick={prepare} disabled={!mapping.address1}>
              Continue
            </Button>
          </div>

          {!mapping.address1 && (
            <p className="mt-3 rounded-lg bg-warn-bg p-3 text-sm text-warn ring-1 ring-warn/25">
              Pick the column holding the street address — it’s the one field an import
              can’t do without.
            </p>
          )}
          {ragged > 0 && (
            <p className="mt-3 rounded-lg bg-warn-bg p-3 text-sm text-warn ring-1 ring-warn/25">
              {ragged.toLocaleString()} row{ragged === 1 ? '' : 's'} had a different number
              of columns than the header. Missing values will be blank — worth a look if
              that’s unexpected.
            </p>
          )}

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {IMPORT_FIELDS.map(({ key, label, required }) => (
              <label key={key} className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                  {label}
                  {required && <span className="ml-1 text-bad">*</span>}
                </span>
                <select
                  value={mapping[key] ?? ''}
                  onChange={(e) =>
                    setMapping((m) => ({ ...m, [key]: e.target.value || undefined }))
                  }
                  className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 bg-white px-2 text-sm"
                >
                  <option value="">— not imported —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                {mapping[key] && (
                  <span className="mt-1 block truncate text-xs text-ink-mute">
                    e.g. {rows[0]?.[mapping[key] as string] || '—'}
                  </span>
                )}
              </label>
            ))}
          </div>
        </section>
      )}

      {/* ---- 3. review and import -------------------------------------- */}
      {stage === 'review' && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Tally label="Ready to import" value={importable.length} tone="good" />
            <Tally
              label="Need an address lookup"
              value={unplaced.length}
              tone={unplaced.length ? 'warn' : 'muted'}
            />
            <Tally label="No street address" value={noAddress.length} tone={noAddress.length ? 'bad' : 'muted'} />
          </div>

          {unplaced.length > 0 && (
            <section className="card mb-4 p-5">
              <h2 className="font-bold">These rows have no coordinates</h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-mute">
                A property without a latitude and longitude can’t appear on a map or in
                a route, so it won’t be imported until it’s placed. Each one comes back
                marked with how precisely it was found — on the house, on the block, or
                only nearby — so you can see what you’re importing before you import it.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <Button onClick={() => void runGeocode()} disabled={busy !== null || mode === 'demo'}>
                  {busy === 'geocode'
                    ? `Looking up… ${progress?.done ?? 0}/${progress?.total ?? 0}`
                    : `Look up ${unplaced.length.toLocaleString()} address${unplaced.length === 1 ? '' : 'es'}`}
                </Button>
                {prepared.some((r) => r.geocodeStatus && r.geocodeStatus !== 'match') && (
                  <p className="text-sm text-ink-mute">
                    {prepared.filter((r) => r.geocodeStatus && r.geocodeStatus !== 'match').length}{' '}
                    couldn’t be placed — usually a typo, a PO box, or a brand-new street.
                  </p>
                )}
              </div>
            </section>
          )}

          <section className="card mb-4 p-5">
            <h2 className="font-bold">Where do these go?</h2>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                  Assign to
                </span>
                <select
                  value={assignRepId}
                  onChange={(e) => setAssignRepId(e.target.value)}
                  className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 bg-white px-2 text-sm"
                >
                  <option value="">Nobody yet — assign later</option>
                  {reps.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.role.replace('_', ' ')})
                      {r.pending ? ' — invite not accepted' : ''}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-ink-mute">
                  Unassigned leads are visible to the office but won’t show on any rep’s
                  map yet.
                </span>
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                  Territory name (optional)
                </span>
                <input
                  value={territoryName}
                  onChange={(e) => setTerritoryName(e.target.value)}
                  placeholder="e.g. Cedar Bend — August"
                  className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 px-3 text-sm"
                />
                <span className="mt-1 block text-xs text-ink-mute">
                  Groups this batch so you can find and reassign it as a unit.
                </span>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ink/[0.06] pt-4">
              <Button
                onClick={() => void runImport()}
                disabled={busy !== null || importable.length === 0 || mode === 'demo'}
              >
                {busy === 'import'
                  ? `Importing… ${progress?.done ?? 0}/${progress?.total ?? 0}`
                  : `Import ${importable.length.toLocaleString()} lead${importable.length === 1 ? '' : 's'}`}
              </Button>
              <p className="text-sm text-ink-mute">
                Re-importing the same file is safe — leads are matched on address, so
                nothing doubles up.
              </p>
            </div>
          </section>

          <PreviewTable rows={prepared} />
        </>
      )}

      {/* ---- 4. done ---------------------------------------------------- */}
      {stage === 'done' && result && (
        <section className="card p-6">
          <h2 className="text-xl font-black">Import finished</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Tally label="New leads created" value={result.created} tone="good" />
            <Tally label="Existing leads updated" value={result.updated} tone="muted" />
            <Tally
              label="Rows skipped"
              value={result.rejected.length + unplaced.length + noAddress.length}
              tone={result.rejected.length + unplaced.length + noAddress.length ? 'warn' : 'muted'}
            />
          </div>

          {result.updated > 0 && (
            <p className="mt-4 text-sm leading-relaxed text-ink-mute">
              The {result.updated.toLocaleString()} updated lead
              {result.updated === 1 ? ' was' : 's were'} already in the system at the same
              address. Their details were refreshed; their status, visit history and next
              action were left alone — a fresh list must never reset a lead a rep has
              already worked.
            </p>
          )}

          {result.rejected.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold">
                {result.rejected.length} row{result.rejected.length === 1 ? '' : 's'} the
                server rejected
              </summary>
              <ul className="mt-2 max-h-52 overflow-y-auto text-sm text-ink-mute">
                {result.rejected.map((r) => (
                  <li key={r.ref} className="border-b border-ink/[0.06] py-1.5">
                    <span className="font-mono text-xs">{r.ref}</span> — {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="mt-5 flex gap-2">
            <Button onClick={reset}>Import another file</Button>
            <Button variant="secondary" onClick={() => window.location.assign('/admin/territories')}>
              See them on the map
            </Button>
          </div>
        </section>
      )}
    </AdminPage>
  )
}

/* --- pieces --------------------------------------------------------------- */

function Steps({ stage }: { stage: Stage }) {
  const steps: [Stage, string][] = [
    ['pick', 'Choose a file'],
    ['map', 'Check the columns'],
    ['review', 'Review and import'],
    ['done', 'Finished'],
  ]
  const activeIdx = steps.findIndex(([s]) => s === stage)
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {steps.map(([s, label], i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${
              i < activeIdx
                ? 'bg-good text-white'
                : i === activeIdx
                  ? 'bg-ink text-white'
                  : 'bg-ink/10 text-ink-mute'
            }`}
          >
            {i < activeIdx ? '✓' : i + 1}
          </span>
          <span className={i === activeIdx ? 'font-semibold' : 'text-ink-mute'}>{label}</span>
          {i < steps.length - 1 && <span className="mx-1 text-ink-faint">→</span>}
        </li>
      ))}
    </ol>
  )
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'good' | 'warn' | 'bad' | 'muted'
}) {
  const ring =
    tone === 'good'
      ? 'ring-good/25 bg-good-bg'
      : tone === 'warn'
        ? 'ring-warn/25 bg-warn-bg'
        : tone === 'bad'
          ? 'ring-bad/25 bg-bad-bg'
          : 'ring-ink/10 bg-surface'
  return (
    <div className={`rounded-field p-4 ring-1 ${ring}`}>
      <p className="nums text-2xl font-black">{value.toLocaleString()}</p>
      <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-ink-mute">{label}</p>
    </div>
  )
}

/**
 * Capped at 100 rows on screen.
 *
 * The point of a preview is to catch a mapping mistake, and a mistake shows up in
 * the first ten rows — rendering five thousand table rows to prove it twice costs
 * a visibly janky page. The count is stated so nobody thinks the rest vanished.
 */
function PreviewTable({ rows }: { rows: PreparedRow[] }) {
  const shown = rows.slice(0, 100)
  return (
    <section className="card overflow-hidden">
      <div className="flex items-baseline justify-between px-5 py-4">
        <h2 className="font-bold">Preview</h2>
        <p className="text-xs text-ink-mute">
          {shown.length < rows.length
            ? `first ${shown.length} of ${rows.length.toLocaleString()} rows`
            : `${rows.length.toLocaleString()} rows`}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-t border-ink/10 text-sm">
          <thead className="bg-surface-sunk text-left text-xs uppercase tracking-wide text-ink-mute">
            <tr>
              <th className="px-3 py-2 font-semibold">Row</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Address</th>
              <th className="px-3 py-2 font-semibold">City</th>
              <th className="px-3 py-2 font-semibold">Owner</th>
              <th className="px-3 py-2 font-semibold">Placed</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const placed = r.lat != null && r.lng != null
              const missingAddress = !r.values.address1
              return (
                <tr key={r.ref} className="border-b border-ink/[0.06] last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-ink-mute">{r.ref}</td>
                  <td className="px-3 py-2">
                    {missingAddress ? (
                      <Badge tone="bad">No address</Badge>
                    ) : placed ? (
                      <Badge tone="good">Ready</Badge>
                    ) : r.geocodeStatus === 'no_match' ? (
                      <Badge tone="bad">Not found</Badge>
                    ) : r.geocodeStatus === 'tie' ? (
                      <Badge tone="warn">Ambiguous</Badge>
                    ) : (
                      <Badge tone="warn">Needs lookup</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.values.address1 || <span className="text-ink-mute">—</span>}
                    {r.matchedAddress && (
                      <span className="block text-xs text-ink-mute">↳ {r.matchedAddress}</span>
                    )}
                    {/*
                      A guessed match is the one worth looking at: the geocoder
                      answered a misspelled address rather than refusing, so the
                      pin is somewhere plausible and possibly wrong.
                    */}
                    {r.partial && (
                      <span className="block text-xs font-medium text-warn">
                        ↳ close match — check this one
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{r.values.city || '—'}</td>
                  <td className="px-3 py-2">{r.values.ownerName || '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {placed ? (
                      <>
                        <span className="font-medium">{PRECISION_LABEL[r.precision ?? 'unknown']}</span>
                        <span className="nums block text-ink-mute">
                          {r.lat!.toFixed(5)}, {r.lng!.toFixed(5)}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad'; children: React.ReactNode }) {
  const cls =
    tone === 'good'
      ? 'bg-good-bg text-good'
      : tone === 'warn'
        ? 'bg-warn-bg text-warn'
        : 'bg-bad-bg text-bad'
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {children}
    </span>
  )
}

/**
 * Said in the operator's terms, not the provider's. "Rooftop" and "on the block"
 * are the difference a rep notices standing in a front garden; ROOFTOP and
 * RANGE_INTERPOLATED are not.
 */
const PRECISION_LABEL: Record<string, string> = {
  rooftop: 'On the house',
  interpolated: 'On the block',
  approximate: 'Nearby only',
  unknown: 'Placed',
}

const num = (v?: string): number | undefined => {
  if (v == null || v === '') return undefined
  // Strips the currency symbols and thousands separators a spreadsheet exports.
  const n = Number(v.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

const validCoord = (n: number | undefined, limit: number): n is number =>
  n != null && Number.isFinite(n) && n !== 0 && Math.abs(n) <= limit
