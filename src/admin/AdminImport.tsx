import { useMemo, useRef, useState } from 'react'
import { describeError, formatReference } from '../lib/errors'
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
  NetworkError,
  apiAssignProperties,
  apiGeocode,
  apiImport,
  apiUsers,
  apiUnblockLeads,
  apiGeocoders,
  type GeocodeProviderDTO,
  type GeocodeUsageDTO,
  type ImportResultDTO,
  type TeamUserDTO,
} from '../lib/http'
import { liveToken } from '../lib/session'
import { describeSpend, estimateLookupSpend } from '../lib/spend'
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
  provider?: string
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
  /*
    Addresses this import refused because they were erased once.

    Kept because the block is only ever discovered here: nothing else in the
    product tells an operator that an address cannot come back, and until now
    nothing anywhere could lift it. The rows are held rather than the refs so
    the lift can send the same addresses the import sent.
  */
  const [blocked, setBlocked] = useState<{ ref: string; address1: string; city?: string; state?: string; zip?: string }[]>([])
  const [unblockReason, setUnblockReason] = useState('')
  const [unblocking, setUnblocking] = useState(false)
  const [unblockNote, setUnblockNote] = useState<string | null>(null)
  const [unblockError, setUnblockError] = useState<string | null>(null)
  const [ragged, setRagged] = useState(0)
  const [mapping, setMapping] = useState<Partial<Record<ImportField, string>>>({})
  const [prepared, setPrepared] = useState<PreparedRow[]>([])

  const [reps, setReps] = useState<TeamUserDTO[]>([])
  /*
    The company's active geocoding provider, so the lookup below can be costed
    before it runs. Null until it loads, and null on any failure — a provider we
    could not read is one we must not put a price on.
  */
  const [geocoder, setGeocoder] = useState<GeocodeProviderDTO | null>(null)
  /** What the server says we have already sent on this company's key. */
  const [geocodeUsage, setGeocodeUsage] = useState<GeocodeUsageDTO | null>(null)
  /*
    Set once the operator has seen the cost and said go. Only ever consulted
    when the batch is actually billable — a free or within-allowance lookup is
    never interrupted, because a confirmation everyone clicks through is worth
    nothing when the expensive one finally arrives.
  */
  const [spendOk, setSpendOk] = useState(false)
  const [assignRepId, setAssignRepId] = useState('')

  /*
    A second rep picker, for after the fact.

    Separate state from `assignRepId` on purpose: that one is a choice made
    before the import and left blank on the path this exists to rescue. Reusing
    it would pre-fill this with the empty answer that caused the problem.
  */
  const [afterRepId, setAfterRepId] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [assignedNotice, setAssignedNotice] = useState<string | null>(null)
  const [assignError, setAssignError] = useState<string | null>(null)
  const [territoryName, setTerritoryName] = useState('')

  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The paid provider rejected everything it was asked.
   *
   * Not an error — the import worked. The chain is built to degrade rather than
   * fail, so Google falling over means Census answered instead and every row
   * still got a pin. The pin is just on the right street rather than the right
   * roof, and without this the operator has no way to tell that from a list of
   * addresses Google genuinely could not place.
   */
  const [providerDown, setProviderDown] = useState<{ provider: string; reason?: string } | null>(
    null,
  )
  const [result, setResult] = useState<ImportResultDTO | null>(null)
  const [copiedSkipped, setCopiedSkipped] = useState(false)

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

  /** Hand the leads this import just wrote to one person. */
  async function assignImported() {
    const token = liveToken()
    const ids = result?.ids ?? []
    if (!token || !afterRepId || ids.length === 0) return
    setAssigning(true)
    setAssignError(null)
    setAssignedNotice(null)
    try {
      // The endpoint caps a request at 500 ids, the same ceiling the import
      // chunks on, so a large import is assigned in the same shape it arrived.
      const CHUNK = 500
      let assigned = 0
      for (let i = 0; i < ids.length; i += CHUNK) {
        const res = await apiAssignProperties(token, {
          propertyIds: ids.slice(i, i + CHUNK),
          repId: afterRepId,
        })
        assigned += res.assigned ?? 0
      }
      // The count is the server's, not the length of what was sent: a lead
      // deleted between importing and assigning is not one that got assigned.
      setResult((r) => (r ? { ...r, unassigned: Math.max(0, (r.unassigned ?? 0) - assigned) } : r))
      setAssignedNotice(
        `${assigned.toLocaleString()} assigned. They arrive on that rep's phone at the next sync.`,
      )
      await refreshFromServer()
    } catch (err) {
      setAssignError(
        describeError(err, 'Could not assign them. The leads are still there.'),
      )
    } finally {
      setAssigning(false)
    }
  }

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
    // The rep dropdown and the lookup price are only needed from here on, and
    // only in live mode.
    if (mode === 'live') {
      void loadReps()
      void loadGeocoder()
    }
  }

  async function loadGeocoder() {
    const token = liveToken()
    if (!token) return
    try {
      const res = await apiGeocoders(token)
      setGeocoder(res.providers.find((p) => p.id === res.active) ?? null)
      setGeocodeUsage(res.usage ?? null)
    } catch {
      /*
        Left null rather than guessed. Without knowing the provider there is no
        honest estimate to show, and showing the wrong one is worse than showing
        none — the operator would stop reading it.
      */
    }
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
    setProviderDown(null)
    setProgress({ done: 0, total: needsGeocode.length })

    const byRef = new Map(prepared.map((r) => [r.ref, r]))
    // Matches GEOCODE_CHUNK on the server; the larger of the two gets a 413.
    // Sized for Google, which has no batch endpoint — one request per address
    // against a Worker's subrequest budget.
    const CHUNK = 40
    try {
      for (let i = 0; i < needsGeocode.length; i += CHUNK) {
        const chunk = needsGeocode.slice(i, i + CHUNK)
        const { matches, attempts } = await apiGeocode(
          token,
          chunk.map((r) => ({
            ref: r.ref,
            address1: r.values.address1 ?? '',
            city: r.values.city,
            state: r.values.state,
            zip: r.values.zip,
          })),
        )

        /*
          Only a paid provider, and only when it failed on everything.

          Census is excluded because it is the bottom of the chain: when it
          fails, rows come back unplaced and the table already says so in the
          row itself. The invisible case is the one above it — the key somebody
          is paying for went quiet and the free one covered, so nothing looks
          wrong anywhere.

          Some errors on a batch are ordinary; a provider that rejected every
          single address is a credential, a quota, or a billing problem.
        */
        const dead = attempts?.find(
          (a) => a.provider !== 'census' && a.errors > 0 && a.errors === a.asked,
        )
        if (dead) setProviderDown({ provider: dead.provider, reason: dead.firstError })
        for (const m of matches) {
          const row = byRef.get(m.ref)
          if (!row) continue
          row.geocodeStatus = m.status
          if (m.status === 'match') {
            row.lat = m.lat
            row.lng = m.lng
            row.matchedAddress = m.matchedAddress
            row.precision = m.precision
            row.provider = m.provider
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

  /**
   * Every row that did not become a lead, in one list, each with its address.
   *
   * Three separate failures were being summed into a single "Rows skipped"
   * count, and only the server's refusals were ever listed. From the operator's
   * side it is one question — which of my rows did not make it, and why — so
   * they are answered together.
   *
   * The address leads because it is the only part an operator can act on: `L37`
   * is a line number in a file they may have edited since, and the address is
   * what they will search for to fix it.
   */
  const skipped = useMemo(() => {
    const byRef = new Map(prepared.map((r) => [r.ref, r]))
    const addressOf = (ref: string) => {
      const row = byRef.get(ref)
      if (!row) return ''
      return [row.values.address1, row.values.city, row.values.state, row.values.zip]
        .filter(Boolean)
        .join(', ')
    }
    const out: { ref: string; address: string; reason: string }[] = []
    for (const r of result?.rejected ?? []) {
      out.push({ ref: r.ref, address: addressOf(r.ref), reason: r.reason })
    }
    for (const r of unplaced) {
      out.push({
        ref: r.ref,
        address: [r.values.address1, r.values.city, r.values.state, r.values.zip]
          .filter(Boolean)
          .join(', '),
        /*
          Named by what the geocoder actually said where it said anything. "No
          coordinates" is the symptom; "the geocoder could not find it" and "the
          lookup errored" need different fixes — the first is a bad address, the
          second is usually a key or a quota.
        */
        reason:
          r.geocodeStatus === 'error'
            ? 'The address lookup failed — this is usually a key or a quota problem, not the address.'
            : r.geocodeStatus === 'tie'
              ? 'The address matched more than one place, so it was not guessed at.'
              : r.geocodeStatus === 'no_match'
                ? 'No coordinates could be found for this address.'
                : 'No coordinates, so it would have had no place on the map.',
      })
    }
    for (const r of noAddress) {
      out.push({
        ref: r.ref,
        address: '',
        reason: 'No address — check that the address column is mapped to the right column.',
      })
    }
    return out
  }, [result, prepared, unplaced, noAddress])

  /*
    Whether the operator still has to agree to be charged.

    False for a free provider, false inside a free allowance, and false once
    they have agreed — so the ordinary path is one click, exactly as before.
  */
  const spendEstimate = estimateLookupSpend(geocoder, unplaced.length, geocodeUsage)
  const needsSpendConfirm = spendEstimate.kind === 'billable' && !spendOk


  async function runImport() {
    const token = liveToken()
    if (!token) {
      setError('Importing needs a live account. Sign in with real credentials.')
      return
    }
    setBusy('import')
    setError(null)

    /*
      In batches, each saved all-or-nothing by the server, and the totals summed
      so the operator sees one number. A batch that fails no longer ends the
      import: its rows are counted as failed, with the server's reference, and
      the next batch goes on — one bad stretch of a thousand-row file does not
      cost the other nine hundred. 250 a batch keeps each request well inside
      the Worker's time, on a slow connection as much as a fast one.
    */
    const CHUNK = 250
    const totals: ImportResultDTO = { created: 0, updated: 0, rejected: [], failed: [] }
    const blockedFound: { ref: string; address1: string; city?: string; state?: string; zip?: string }[] = []
    setProgress({ done: 0, total: importable.length })

    try {
      for (let i = 0; i < importable.length; i += CHUNK) {
        const chunk = importable.slice(i, i + CHUNK)
        let res: ImportResultDTO
        try {
        res = await apiImport(token, {
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
            /*
              The geocoder's verdict, sent on rather than shown and discarded.
              The preview has always told the operator which rows were guesses;
              until now the app forgot the moment they were saved, so a rep on
              the doorstep saw an estimated pin drawn exactly like an exact one.
            */
            precision: r.precision,
            geoProvider: r.provider,
          })),
          assignRepId: assignRepId || undefined,
          territoryName: territoryName.trim() || undefined,
        })
        } catch (err) {
          // Signed out, or a request the server refuses outright: the next
          // batch would fail the same way, so stop and say so.
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err
          totals.failed!.push({
            firstRef: chunk[0]?.ref ?? '',
            lastRef: chunk[chunk.length - 1]?.ref ?? '',
            rows: chunk.length,
            message: err instanceof ApiError ? err.message : err instanceof NetworkError ? 'No connection to the server.' : 'The batch could not be saved.',
            reference: err instanceof ApiError ? err.reference : undefined,
          })
          setProgress({ done: Math.min(i + CHUNK, importable.length), total: importable.length })
          continue
        }
        totals.created += res.created
        totals.updated += res.updated
        totals.rejected.push(...res.rejected)
        /*
          "was erased" is the server's wording for a tombstoned address. Matched
          on rather than given a code because the reason is already a sentence
          an operator reads; a parallel machine-readable field would be a second
          thing to keep in step for no gain at this size.
        */
        for (const r of res.rejected.filter((x) => /was erased/i.test(x.reason))) {
          const row = chunk.find((c) => c.ref === r.ref)
          if (row) {
            blockedFound.push({
              ref: r.ref,
              address1: row.values.address1 ?? '',
              city: row.values.city,
              state: row.values.state,
              zip: row.values.zip,
            })
          }
        }
        totals.territoryId ??= res.territoryId
        totals.territoryCreated ||= !!res.territoryCreated
        /*
          Summed across chunks, and left undefined when the server never sent it.
          A Worker predating territory matching returns nothing here, and adding
          zero to zero would report "0 leads matched a territory" — which reads
          as every lead missing its patch rather than as a server that has never
          heard of the question.
        */
        if (res.territoryMatched != null) {
          totals.territoryMatched = (totals.territoryMatched ?? 0) + res.territoryMatched
        }
        if (res.territoryUnmatched != null) {
          totals.territoryUnmatched = (totals.territoryUnmatched ?? 0) + res.territoryUnmatched
        }
        if (res.ids?.length) totals.ids = [...(totals.ids ?? []), ...res.ids]
        if (res.unassigned != null) {
          totals.unassigned = (totals.unassigned ?? 0) + res.unassigned
        }
        setProgress({ done: Math.min(i + CHUNK, importable.length), total: importable.length })
      }
      setResult(totals)
      setBlocked(blockedFound)
      setStage('done')
      // Pull the new leads into the console's own view of the world.
      await refreshFromServer()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? describeError(err, 'The import failed. Nothing was lost — try again.')
          : 'The import failed. Nothing was lost — try again.',
      )
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
    setBlocked([])
    setUnblockReason('')
    setUnblockNote(null)
    setUnblockError(null)
  }

  /*
    Lift the block on the addresses this import refused.

    Nothing comes back: the leads, their notes, visits and photos were
    destroyed and stay destroyed. All this does is allow the addresses to exist
    again, so the next import can create them fresh. It is admin-only, it takes
    a reason, and it writes an audit line naming the count — because the one
    erasure that must never be lifted is the one a homeowner asked for, and an
    auditor has to be able to see who decided otherwise.
  */
  async function liftBlocks() {
    const token = liveToken()
    if (!token || unblocking) return
    setUnblocking(true)
    setUnblockError(null)
    setUnblockNote(null)
    try {
      const res = await apiUnblockLeads(token, {
        rows: blocked.map((b) => ({ address1: b.address1, city: b.city, state: b.state, zip: b.zip })),
        reason: unblockReason.trim(),
      })
      setUnblockNote(
        `${res.unblocked} address${res.unblocked === 1 ? '' : 'es'} can be imported again. Upload the file once more to create them.`,
      )
      setBlocked([])
      setUnblockReason('')
    } catch (err) {
      setUnblockError(describeError(err, 'That did not go through. Nothing was changed.'))
    } finally {
      setUnblocking(false)
    }
  }

  /* --- render ---------------------------------------------------------- */

  return (
    <AdminPage
      tour="console-import"
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

      {/*
        Deliberately not `role="alert"`, and deliberately not styled as an
        error. Nothing failed and nothing needs undoing — the pins are simply
        coarser than the account is paying for, and saying so in red next to a
        working import trains people to ignore red.
      */}
      {providerDown && (
        <div
          data-testid="provider-down"
          className="mb-4 rounded-field bg-warn-bg p-3 text-sm text-warn ring-1 ring-warn/25"
        >
          <p className="font-semibold">
            {providerDown.provider === 'google' ? 'Google' : providerDown.provider} rejected every
            address in a batch.
          </p>
          <p className="mt-1 leading-relaxed">
            These leads were placed by the free block-level service instead, so their pins are on
            the right street rather than the right roof. The import is fine — but the key you are
            paying for is not being used. Check it before importing a large list.
          </p>
          {providerDown.reason && (
            <p className="mt-1.5 font-mono text-[12px] opacity-80">{providerDown.reason}</p>
          )}
        </div>
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
                <span className="text-[12.5px] font-medium text-ink-mute">
                  {label}
                  {required && <span className="ml-1 text-bad">*</span>}
                </span>
                <select
                  value={mapping[key] ?? ''}
                  onChange={(e) =>
                    setMapping((m) => ({ ...m, [key]: e.target.value || undefined }))
                  }
                  className="focusable mt-1 h-11 w-full rounded-lg border border-line bg-surface-field px-2 text-sm"
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
              {/*
                The cost, before the button rather than after the invoice.

                A company on their own key is billed per address by the vendor,
                and nothing in this app caps or interrupts that. This line is the
                only thing between an operator and a bill they did not expect —
                see LAUNCH.md item 5. It says nothing at all on the free Census
                lookup, so when it does appear it means something.
              */}
              <SpendNotice provider={geocoder} lookups={unplaced.length} usage={geocodeUsage} />

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {/*
                  A batch that will be billed asks first.

                  Not a hard cap: this app cannot see the vendor's meter, so any
                  ceiling it enforced would be guesswork dressed as a limit. What
                  it can do is make sure the person spending the money is the one
                  who decides, at the moment they spend it — and the free path is
                  left uninterrupted so this prompt still means something when it
                  does appear.
                */}
                {needsSpendConfirm ? (
                  <>
                    {/*
                      One click, and it carries the figure being agreed to.

                      An earlier version revealed the real button instead of
                      running, which made the operator click twice and put the
                      number on the first button and the action on the second —
                      the two things that need to be in the same place.
                    */}
                    <Button
                      onClick={() => {
                        setSpendOk(true)
                        void runGeocode()
                      }}
                      disabled={busy !== null || mode === 'demo'}
                    >
                      {spendEstimate.kind === 'billable'
                        ? `Look up anyway — about $${spendEstimate.estimateUsd.toFixed(2)}`
                        : 'Look up anyway'}
                    </Button>
                    <p className="text-sm text-ink-soft">
                      Nothing is charged until you press this.
                    </p>
                  </>
                ) : (
                <Button onClick={() => void runGeocode()} disabled={busy !== null || mode === 'demo'}>
                  {busy === 'geocode'
                    ? `Looking up… ${progress?.done ?? 0}/${progress?.total ?? 0}`
                    : `Look up ${unplaced.length.toLocaleString()} address${unplaced.length === 1 ? '' : 'es'}`}
                </Button>
                )}
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
                <span className="text-[12.5px] font-medium text-ink-mute">
                  Assign to
                </span>
                <select
                  value={assignRepId}
                  onChange={(e) => setAssignRepId(e.target.value)}
                  className="focusable mt-1 h-11 w-full rounded-lg border border-line bg-surface-field px-2 text-sm"
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
                <span className="text-[12.5px] font-medium text-ink-mute">
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

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line-soft pt-4">
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
          <h2 className="text-[19px] font-semibold tracking-[-0.01em]">Import finished</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Tally label="New leads created" value={result.created} tone="good" />
            <Tally label="Existing leads updated" value={result.updated} tone="muted" />
            <Tally
              label="Rows skipped"
              value={result.rejected.length + unplaced.length + noAddress.length}
              tone={result.rejected.length + unplaced.length + noAddress.length ? 'warn' : 'muted'}
            />
          </div>
          <p className="mt-3 text-[13px] text-ink-mute" data-testid="import-summary">
            {(importable.length + unplaced.length + noAddress.length).toLocaleString()} rows in the file ·{' '}
            {result.created.toLocaleString()} imported · {result.updated.toLocaleString()} updated ·{' '}
            {result.rejected.filter((r) => /duplicate/i.test(r.reason)).length.toLocaleString()} duplicates ·{' '}
            {unplaced.length.toLocaleString()} could not be placed on the map ·{' '}
            {(result.failed ?? []).reduce((n, f) => n + f.rows, 0).toLocaleString()} failed
          </p>
          {(result.failed?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-card border border-bad/40 bg-bad/5 p-4" data-testid="import-failed" role="alert">
              <p className="text-sm font-semibold text-bad">
                {result.failed!.reduce((n, f) => n + f.rows, 0).toLocaleString()} rows were not saved. The rest of the file was.
              </p>
              <ul className="mt-2 space-y-1 text-[13px] text-ink-soft">
                {result.failed!.map((f) => (
                  <li key={f.firstRef}>
                    Rows {f.firstRef}–{f.lastRef}: {f.message}
                    {f.reference && <span className="font-mono"> Reference: {formatReference(f.reference)}</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[13px] text-ink-mute">Importing the same file again is safe: rows already saved are updated, not duplicated.</p>
            </div>
          )}

          {/*
            The thing that otherwise goes unsaid.

            A rep's phone only ever receives leads assigned to them — that is
            deliberate, and it is what stops a five-thousand-lead database
            syncing onto every handset. The consequence nobody warns you about
            is that an import with no rep picked produces a console showing five
            hundred healthy new leads and five hundred phones showing nothing,
            with no error anywhere. The first person to notice is a rep saying
            the app is broken.

            So it is said here, in the one moment somebody is holding the intent
            and can act on it in a single tap.
          */}
          {/*
            Kept on screen once it has been acted on, rather than unmounting.

            Assigning drops the count to zero, and the first version of this
            hid the whole block the moment it did — taking the confirmation
            with it. The warning simply vanished, which reads as the page
            losing its place rather than as the job being done.
          */}
          {(!!result.unassigned || assignedNotice) && (
            <div
              className={`mt-4 rounded-card border p-4 ${
                result.unassigned ? 'border-warn/40 bg-warn/5' : 'border-good/40 bg-good/5'
              }`}
            >
              {!result.unassigned && assignedNotice ? (
                <p className="text-sm font-semibold text-good">{assignedNotice}</p>
              ) : (
                <>
              <p className="text-sm font-semibold text-warn">
                {(result.unassigned ?? 0).toLocaleString()} lead{result.unassigned === 1 ? '' : 's'}{' '}
                {result.unassigned === 1 ? 'is' : 'are'} assigned to nobody
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                Reps only see leads assigned to them, so until somebody owns{' '}
                {result.unassigned === 1 ? 'it' : 'these'} {result.unassigned === 1 ? 'it' : 'they'}{' '}
                will not appear on any phone.
              </p>

              {reps.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="min-w-[220px] flex-1">
                    <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">
                      Assign them to
                    </span>
                    <select
                      value={afterRepId}
                      onChange={(e) => setAfterRepId(e.target.value)}
                      className="field h-[46px] w-full"
                    >
                      <option value="">— pick somebody —</option>
                      {reps.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    size="sm"
                    disabled={!afterRepId || assigning || !result.ids?.length}
                    onClick={() => void assignImported()}
                  >
                    {assigning ? 'Assigning…' : 'Assign'}
                  </Button>
                  {assignedNotice && (
                    <span className="text-xs font-medium text-good">{assignedNotice}</span>
                  )}
                  {assignError && <span className="text-xs font-medium text-bad">{assignError}</span>}
                </div>
              ) : (
                <p className="mt-2 text-[13px] text-ink-mute">
                  Invite somebody to the team first, then assign these from the Leads screen.
                </p>
              )}

              {!result.ids?.length && (
                /*
                  An older Worker does not return the ids, so the offer cannot
                  target this import. Saying where to go beats a dead button.
                */
                <p className="mt-2 text-[13px] text-ink-mute">
                  Assign them from the Leads screen — they are the ones showing “Nobody”.
                </p>
              )}
                </>
              )}
            </div>
          )}

          {result.territoryMatched != null &&
            result.territoryMatched + (result.territoryUnmatched ?? 0) > 0 && (
              <p className="mt-4 text-sm leading-relaxed text-ink-mute">
                {result.territoryMatched > 0 ? (
                  <>
                    <strong className="text-ink">
                      {result.territoryMatched.toLocaleString()} lead
                      {result.territoryMatched === 1 ? '' : 's'}
                    </strong>{' '}
                    landed inside a territory you have drawn and{' '}
                    {result.territoryMatched === 1 ? 'was' : 'were'} assigned to whoever works
                    it.{' '}
                  </>
                ) : null}
                {result.territoryUnmatched ? (
                  <>
                    {result.territoryUnmatched.toLocaleString()} fell outside every drawn
                    territory and {result.territoryUnmatched === 1 ? 'is' : 'are'} waiting to be
                    assigned — draw a patch around them on the map and they will be picked up.
                  </>
                ) : null}
              </p>
            )}

          {result.updated > 0 && (
            <p className="mt-4 text-sm leading-relaxed text-ink-mute">
              The {result.updated.toLocaleString()} updated lead
              {result.updated === 1 ? ' was' : 's were'} already in the system at the same
              address. Their details were refreshed; their status, visit history and next
              action were left alone — a fresh list must never reset a lead a rep has
              already worked.
            </p>
          )}

          {/*
            Every row that did not become a lead, named and explained.

            The counts were here before this and the detail was not, which is
            the wrong way round: "Rows skipped: 9" tells an operator that
            something is wrong and nothing about what to do next. Reported from
            the console — "there were some imported and some not, we need to see
            who was an error/why they were not imported".

            Three different failures were being added into that one number and
            only one of them was ever listed:

              - the server refused it (a duplicate, an erased address)
              - no coordinates, so it would have been a lead with no place on
                the map — the geocoder was asked and could not answer
              - no address at all, which is usually a column mapped wrongly

            All three are shown together, because from the operator's side they
            are one question. And each row leads with its **address**, not its
            line number: `L37` is not something anybody can look up, and the
            address is what they will search for in the spreadsheet they are
            about to fix.

            Copyable as a block, because fixing ten of these means pasting them
            somewhere — and re-uploading a corrected file is the whole point.
          */}
          {skipped.length > 0 && (
            <details className="mt-4" open>
              <summary className="cursor-pointer text-sm font-semibold">
                {skipped.length} row{skipped.length === 1 ? '' : 's'} did not import
              </summary>

              <ul className="mt-2 max-h-64 overflow-y-auto text-sm">
                {skipped.map((r) => (
                  <li key={r.ref} className="border-b border-line-soft py-1.5">
                    <span className="font-medium text-ink">{r.address || '(no address)'}</span>
                    <span className="ml-2 font-mono text-[11px] text-ink-mute">{r.ref}</span>
                    <span className="block text-[13px] text-ink-mute">{r.reason}</span>
                  </li>
                ))}
              </ul>

              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                data-testid="copy-skipped"
                onClick={() => {
                  const text = skipped
                    .map((r) => `${r.ref}\t${r.address}\t${r.reason}`)
                    .join('\n')
                  void navigator.clipboard?.writeText(text).then(
                    () => setCopiedSkipped(true),
                    () => setCopiedSkipped(false),
                  )
                }}
              >
                {copiedSkipped ? 'Copied' : 'Copy these rows'}
              </Button>
            </details>
          )}

          {/*
            The only place in the product where an erasure block is discovered,
            and now the only place it can be lifted.

            It sits under the rejected rows because that is where the operator
            has just read "This address was erased". Before this, that sentence
            was the end of the road: nothing in the API removed a tombstone, so
            an address erased while clearing out test data could never be
            imported again for that company, by anyone, ever.
          */}
          {blocked.length > 0 && (
            <section className="mt-4 rounded-field bg-warn-bg px-4 py-3" data-testid="import-blocked">
              <h3 className="text-sm font-bold text-warn">
                {blocked.length} address{blocked.length === 1 ? '' : 'es'} {blocked.length === 1 ? 'was' : 'were'} erased before and {blocked.length === 1 ? 'is' : 'are'} blocked
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-warn">
                Importing a lead that was deliberately destroyed would undo that, so it is refused. You can allow these
                addresses back — nothing is restored, they are simply permitted to exist again, and the next import creates
                them fresh. <strong>Do not lift a block on someone who asked to be removed.</strong>
              </p>
              <ul className="mt-2 max-h-32 overflow-y-auto text-xs text-warn">
                {blocked.map((b) => (
                  <li key={b.ref} className="py-0.5">
                    <span className="font-mono">{b.ref}</span> — {b.address1}
                  </li>
                ))}
              </ul>
              <label className="mt-3 block">
                <span className="text-xs font-semibold text-warn">Why are these allowed back?</span>
                <input
                  value={unblockReason}
                  onChange={(e) => setUnblockReason(e.target.value)}
                  placeholder="e.g. Deleted while clearing test data, these are real houses"
                  disabled={unblocking}
                  data-testid="unblock-reason"
                  className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 bg-surface px-3 text-[15px]"
                />
              </label>
              <Button
                variant="secondary"
                className="mt-3"
                disabled={unblocking || unblockReason.trim().length < 3}
                onClick={() => void liftBlocks()}
                data-testid="unblock-apply"
              >
                {unblocking ? 'Allowing…' : `Allow ${blocked.length === 1 ? 'this address' : 'these addresses'} again`}
              </Button>
              {unblockError && (
                <p role="alert" className="mt-2 text-xs font-medium text-bad" data-testid="unblock-error">
                  {unblockError}
                </p>
              )}
            </section>
          )}
          {unblockNote && (
            <p role="status" className="mt-4 rounded-field bg-good-bg px-4 py-3 text-xs font-medium text-good" data-testid="unblock-note">
              {unblockNote}
            </p>
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
                ? 'bg-good text-surface-sunk'
                : i === activeIdx
                  ? 'bg-ink text-white'
                  : 'bg-line text-ink-mute'
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
          : 'ring-line bg-surface'
  return (
    <div className={`rounded-field p-4 ring-1 ${ring}`}>
      <p className="nums text-[22px] font-semibold tracking-[-0.02em]">{value.toLocaleString()}</p>
      <p className="mt-0.5 text-[12.5px] font-medium text-ink-mute">{label}</p>
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
/**
 * What this batch of lookups will cost, in a sentence.
 *
 * Silent on a free provider. That silence is deliberate and is what gives the
 * warning its weight: an operator who sees a cost line on every import stops
 * reading it by the third one.
 */
function SpendNotice({
  provider,
  lookups,
  usage,
}: {
  provider: GeocodeProviderDTO | null
  lookups: number
  usage: GeocodeUsageDTO | null
}) {
  const note = describeSpend(estimateLookupSpend(provider, lookups, usage))
  if (!note || lookups === 0) return null
  return (
    <p
      data-testid="spend-notice"
      className={`mt-3 rounded-lg px-4 py-3 text-sm leading-relaxed ${
        note.tone === 'warn' ? 'bg-warn-bg text-warn' : 'bg-surface-sunk text-ink-soft'
      }`}
    >
      {note.text}
    </p>
  )
}

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
        <table className="w-full min-w-[820px] border-t border-line text-sm">
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
                <tr key={r.ref} className="border-b border-line-soft last:border-0">
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
