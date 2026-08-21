import type { ReactNode } from 'react'
import { IconChevron } from '../components/nav/icons'

/**
 * One list, two shapes: cards on a phone, a table on a desktop.
 *
 * The console's screens were tables, and a table on a 390px screen is not a
 * cramped table — it is a broken one. Columns four through nine were simply off
 * the right edge with no scrollbar and no hint they existed, so a manager
 * checking a rep's contact rate from a truck could see their name, their role,
 * and half of "Territory".
 *
 * The fix is not to shrink the table. A table is a *comparison* instrument: its
 * value is that column four lines up across thirty rows, and a phone cannot hold
 * enough of one for that to be true. What a phone is usually asked is the other
 * question — "what about this one?" — which a card answers better than a row
 * ever did. So each column declares where it belongs on a phone and the same
 * data renders as either.
 *
 * `phone`:
 *   `title`     the row's identity, top of the card
 *   `subtitle`  one quiet line under it
 *   `meta`      a labelled pair in the card's grid — the label is the column
 *               header, which is the whole reason a table needs one
 *   `trailing`  right-aligned against the title: a status, a value
 *   `off`       desktop only, for columns that are noise on a phone
 *
 * Nothing is hidden without being deliberate: a column with no `phone` shows as
 * `meta`, so forgetting to think about one is a slightly long card rather than
 * missing data.
 */

export interface Column<T> {
  header: string
  cell: (row: T) => ReactNode
  phone?: 'title' | 'subtitle' | 'meta' | 'trailing' | 'off'
  /** Numeric columns right-align in the table. */
  align?: 'right'
  /** Applied to the table cell only. */
  className?: string
}

export function DataList<T>({
  columns,
  rows,
  keyOf,
  leading,
  leadingHeader,
  onRow,
  isSelected,
  rowLabel,
  empty,
  className = '',
}: {
  columns: Column<T>[]
  rows: T[]
  keyOf: (row: T) => string
  /**
   * A control at the start of every row — in practice a bulk-select checkbox.
   *
   * Its own slot rather than a column, because it is the one thing that must
   * stay in the same place in both shapes: first cell of the table, and left of
   * the card's title. A checkbox that moves into the meta grid on a phone is a
   * checkbox nobody finds.
   */
  leading?: (row: T) => ReactNode
  /** Header cell above `leading` — usually a select-all checkbox. */
  leadingHeader?: ReactNode
  /**
   * Makes the row activate — the whole card on a phone, the whole `<tr>` on a
   * desktop.
   *
   * Both, deliberately. The first version wired this into the cards only, which
   * silently removed row selection from the desktop table: clicking a territory
   * stopped filtering the map beside it, and the only thing that noticed was a
   * gate asserting the panel and the table agree.
   */
  onRow?: (row: T) => void
  /** Marks the active row — the table tints it, matching the card's press state. */
  isSelected?: (row: T) => boolean
  /** Accessible name for the card button — the visible title is usually markup. */
  rowLabel?: (row: T) => string
  empty: ReactNode
  className?: string
}) {
  if (rows.length === 0) {
    return (
      <div className={`rounded-card border border-line bg-surface p-8 text-center ${className}`}>
        <p className="text-sm text-ink-mute">{empty}</p>
      </div>
    )
  }

  const at = (where: Column<T>['phone']) => columns.filter((c) => c.phone === where)
  const meta = columns.filter((c) => c.phone === 'meta' || c.phone === undefined)

  return (
    <>
      {/* --- phone: cards ---------------------------------------------- */}
      <ul className={`flex flex-col gap-3 lg:hidden ${className}`}>
        {rows.map((row) => {
          const body = (
            <>
              <div className="flex items-start justify-between gap-3">
                {leading && <div className="shrink-0 pt-0.5">{leading(row)}</div>}
                <div className="min-w-0 flex-1">
                  {at('title').map((c) => (
                    <div key={c.header} className="text-[15px] font-medium text-ink">
                      {c.cell(row)}
                    </div>
                  ))}
                  {at('subtitle').map((c) => (
                    <div key={c.header} className="mt-0.5 text-[13px] text-ink-mute">
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {at('trailing').map((c) => (
                    <div key={c.header} className="text-[13px]">
                      {c.cell(row)}
                    </div>
                  ))}
                  {onRow && (
                    <span className="text-ink-faint" aria-hidden>
                      <IconChevron />
                    </span>
                  )}
                </div>
              </div>

              {meta.length > 0 && (
                /*
                  Two columns. The header goes *above* the value rather than
                  beside it: label-left/value-right reads as a spreadsheet, and
                  at this width a long header would push the number off the row.
                */
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-line-soft pt-3">
                  {meta.map((c) => (
                    <div key={c.header} className="min-w-0">
                      <dt className="truncate text-[11.5px] font-medium text-ink-mute">
                        {c.header}
                      </dt>
                      <dd className="mt-0.5 truncate text-[14px] text-ink">{c.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          )

          return (
            <li key={keyOf(row)}>
              {onRow ? (
                <button
                  onClick={() => onRow(row)}
                  aria-label={rowLabel?.(row)}
                  className="card-tap focusable w-full p-4 text-left"
                >
                  {body}
                </button>
              ) : (
                <div className="card p-4">{body}</div>
              )}
            </li>
          )
        })}
      </ul>

      {/* --- desktop: the table it always was --------------------------- */}
      <div
        className={`hidden overflow-hidden rounded-card border border-line bg-surface lg:block ${className}`}
      >
        <table className="w-full text-sm">
          <thead className="bg-surface-sunk text-xs text-ink-mute">
            <tr>
              {leading && <th className="w-10 px-3 py-2.5 pl-5">{leadingHeader}</th>}
              {columns.map((c) => (
                <th
                  key={c.header}
                  className={`px-3 py-2.5 font-medium last:pr-5 ${leading ? '' : 'first:pl-5'} ${
                    c.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={keyOf(row)}
                onClick={onRow ? () => onRow(row) : undefined}
                aria-selected={isSelected ? isSelected(row) : undefined}
                className={`border-t border-line-soft ${onRow ? 'cursor-pointer' : ''} ${
                  isSelected?.(row) ? 'bg-brand-50' : 'hover:bg-surface-field'
                }`}
              >
                {leading && <td className="px-3 py-3 pl-5">{leading(row)}</td>}
                {columns.map((c) => (
                  <td
                    key={c.header}
                    className={`px-3 py-3 last:pr-5 ${leading ? '' : 'first:pl-5'} ${
                      c.align === 'right' ? 'nums text-right' : ''
                    } ${c.className ?? ''}`}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
