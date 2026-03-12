import { isValidCaseStatus } from '@/app/lib/case-status'

export type CsvRow = Record<string, string>

export const CASE_CSV_TEMPLATE_HEADERS = [
  'driver_name',
  'first_name',
  'last_name',
  'state',
  'county',
  'citation_number',
  'violation_code',
  'violation_date',
  'court_name',
  'court_date',
  'court_case_number',
  'status',
  'fleet_id',
  'agency_id',
  'driver_id',
  'attorney_firm_id',
  'assigned_attorney_user_id',
  'notes',
] as const

export function buildCaseCsvTemplate() {
  return `${CASE_CSV_TEMPLATE_HEADERS.join(',')}\n`
}

export function normalizeCsvHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function parseCsvRows(rawCsv: string): CsvRow[] {
  const parsed: string[][] = []
  let currentCell = ''
  let currentRow: string[] = []
  let inQuotes = false

  for (let i = 0; i < rawCsv.length; i += 1) {
    const char = rawCsv[i]

    if (char === '"') {
      const nextChar = rawCsv[i + 1]
      if (inQuotes && nextChar === '"') {
        currentCell += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentCell)
      currentCell = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && rawCsv[i + 1] === '\n') {
        i += 1
      }
      currentRow.push(currentCell)
      currentCell = ''
      if (currentRow.some((cell) => cell.trim() !== '')) {
        parsed.push(currentRow)
      }
      currentRow = []
      continue
    }

    currentCell += char
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell)
    if (currentRow.some((cell) => cell.trim() !== '')) {
      parsed.push(currentRow)
    }
  }

  if (!parsed.length) return []

  const headers = parsed[0].map((header, index) => normalizeCsvHeader(header) || `column_${index + 1}`)
  return parsed.slice(1).flatMap((record) => {
    const row: CsvRow = {}
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = String(record[i] ?? '').trim()
    }
    return Object.values(row).some((value) => value !== '') ? [row] : []
  })
}

export function getCsvValue(row: CsvRow, keys: string[]) {
  for (const key of keys) {
    const value = String(row[normalizeCsvHeader(key)] ?? '').trim()
    if (value) return value
  }
  return ''
}

export function parseCaseDateInput(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed
  }

  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
  const match = trimmed.match(mdy)
  if (match) {
    const month = String(match[1]).padStart(2, '0')
    const day = String(match[2]).padStart(2, '0')
    const year = match[3].length === 2 ? `20${match[3]}` : match[3]
    return `${year}-${month}-${day}`
  }

  const date = new Date(trimmed)
  if (Number.isNaN(+date)) {
    return null
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function normalizeCaseStatusValue(rawStatus: string) {
  const status = rawStatus.trim().toUpperCase()
  if (!status) return 'INTAKE_RECEIVED'
  if (isValidCaseStatus(status)) return status
  if (['INTAKE', 'NEW', 'OPEN', 'PENDING'].includes(status)) return 'INTAKE_RECEIVED'
  if (['REVIEW', 'NEEDS_REVIEW'].includes(status)) return 'NEEDS_REVIEW'
  if (['FILED', 'WORKING', 'IN_PROGRESS'].includes(status)) return 'IN_PROGRESS'
  if (['RESOLVED', 'COMPLETE', 'COMPLETED', 'CLOSED'].includes(status)) return 'CLOSED'
  return 'INTAKE_RECEIVED'
}

export function splitDriverName(rawName: string) {
  const trimmed = rawName.trim()
  if (!trimmed) return { firstName: '', lastName: '' }
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' }
  }
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts.at(-1) ?? '',
  }
}
