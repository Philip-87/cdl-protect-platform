import type { ReactNode } from 'react'
import Link from 'next/link'
import { getCaseCourtCaseNumber, getCaseDisplayDriverName, getCaseViolationDate } from '@/app/lib/cases/display'

export type SharedCaseQueueRow = {
  id: string
  state: string | null
  court_name?: string | null
  court_date: string | null
  citation_number?: string | null
  status: string
  violation_date?: string | null
  court_case_number?: string | null
  updated_at?: string | null
  metadata?: Record<string, unknown> | null
}

export type SharedCaseQueueExtraColumn<T extends SharedCaseQueueRow> = {
  key: string
  header: string
  className?: string
  render: (row: T) => ReactNode
}

function formatCaseDate(value: string | null | undefined) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return '-'
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)

  const parsed = new Date(trimmed)
  if (Number.isNaN(+parsed)) return trimmed

  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function QueueEyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 5C6.5 5 2.1 8.4 1 12c1.1 3.6 5.5 7 11 7s9.9-3.4 11-7c-1.1-3.6-5.5-7-11-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-2.2a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function SharedCaseQueueTable<T extends SharedCaseQueueRow>({
  rows,
  selectedCaseId,
  showSelection = false,
  selectionName = 'case_ids',
  getSelectionAriaLabel,
  renderOpenCell,
  getRowHref,
  getRowSubtitle,
  extraColumns = [],
  tableClassName = '',
}: {
  rows: T[]
  selectedCaseId?: string | null
  showSelection?: boolean
  selectionName?: string
  getSelectionAriaLabel?: (row: T) => string
  renderOpenCell: (row: T) => ReactNode
  getRowHref?: (row: T) => string | null
  getRowSubtitle?: (row: T) => ReactNode
  extraColumns?: SharedCaseQueueExtraColumn<T>[]
  tableClassName?: string
}) {
  return (
    <div className="table-shell">
      <table className={`data-table shared-case-queue-table ${tableClassName}`.trim()}>
        <thead>
          <tr>
            {showSelection ? <th>Select</th> : null}
            <th>Open</th>
            <th>Driver Name</th>
            <th>Ticket Violation Date</th>
            <th>State</th>
            <th>Court Name</th>
            <th>Court Date</th>
            <th>Current Status</th>
            <th>Citation Number</th>
            <th>Court Case Number</th>
            {extraColumns.map((column) => (
              <th key={column.key} className={column.className}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowHref = getRowHref?.(row) ?? null
            const driverName = getCaseDisplayDriverName(row)
            const violationDate = getCaseViolationDate(row)
            const courtCaseNumber = getCaseCourtCaseNumber(row)

            return (
              <tr key={row.id} className={selectedCaseId === row.id ? 'selected-row' : ''}>
                {showSelection ? (
                  <td>
                    <input
                      type="checkbox"
                      name={selectionName}
                      value={row.id}
                      aria-label={getSelectionAriaLabel?.(row) ?? `Select case ${row.id}`}
                    />
                  </td>
                ) : null}
                <td>{renderOpenCell(row)}</td>
                <td>
                  <div className="case-table-primary">
                    {rowHref ? (
                      <Link href={rowHref} className="dashboard-table-link">
                        {driverName}
                      </Link>
                    ) : (
                      <span>{driverName}</span>
                    )}
                    {getRowSubtitle ? <span className="case-table-secondary">{getRowSubtitle(row)}</span> : null}
                  </div>
                </td>
                <td>{violationDate ?? '-'}</td>
                <td>{row.state ?? '-'}</td>
                <td>{row.court_name ?? '-'}</td>
                <td>{formatCaseDate(row.court_date)}</td>
                <td>
                  <span className="badge">{row.status}</span>
                </td>
                <td className="shared-case-queue-citation">
                  {rowHref ? (
                    <Link href={rowHref} className="dashboard-table-link">
                      {row.citation_number ?? row.id}
                    </Link>
                  ) : (
                    <strong>{row.citation_number ?? row.id}</strong>
                  )}
                </td>
                <td>{courtCaseNumber ?? '-'}</td>
                {extraColumns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
