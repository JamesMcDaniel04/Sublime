/**
 * CSV datapoint import: `date,value` rows (header optional). Pure parser —
 * the route applies the rows. Malformed lines never abort the valid
 * remainder; every skip is reported with its line number and reason.
 */
import { parseSheetNumber } from '@/lib/metrics/sources/google-sheets'
import { bucketKeyFor } from './refresh'

export const MAX_IMPORT_ROWS = 1000

export type CsvImportRow = { capturedAt: Date; value: number; bucketKey: string }
export type CsvImportSkip = { line: number; reason: string }

export function parseDatapointCsv(text: string): {
  rows: CsvImportRow[]
  skipped: CsvImportSkip[]
} {
  const rows: CsvImportRow[] = []
  const skipped: CsvImportSkip[] = []
  const seenBuckets = new Set<string>()
  const lines = text.split(/\r?\n/)

  lines.forEach((rawLine, index) => {
    const line = index + 1
    const trimmed = rawLine.trim()
    if (!trimmed) return
    const [rawDate, rawValue, ...rest] = trimmed.split(',').map((cell) => cell.trim())
    if (rest.length > 0 && rest.some((cell) => cell !== '')) {
      skipped.push({ line, reason: 'expected exactly two columns (date,value)' })
      return
    }
    if (rawValue === undefined) {
      skipped.push({ line, reason: 'missing value column' })
      return
    }
    const value = parseSheetNumber([[rawValue]])
    if (value === null) {
      // A non-numeric value on line 1 is a header — skip silently.
      if (line === 1) return
      skipped.push({ line, reason: `'${rawValue}' is not a number` })
      return
    }
    const capturedAt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate}T12:00:00Z` : rawDate)
    if (Number.isNaN(capturedAt.getTime())) {
      skipped.push({ line, reason: `'${rawDate}' is not a date (use YYYY-MM-DD)` })
      return
    }
    if (capturedAt.getTime() > Date.now()) {
      skipped.push({ line, reason: 'future-dated readings are not importable' })
      return
    }
    if (rows.length >= MAX_IMPORT_ROWS) {
      skipped.push({ line, reason: `row limit (${MAX_IMPORT_ROWS}) reached` })
      return
    }
    const bucketKey = bucketKeyFor(capturedAt)
    if (seenBuckets.has(bucketKey)) {
      skipped.push({ line, reason: `duplicate day ${bucketKey} (last one wins was NOT applied — first kept)` })
      return
    }
    seenBuckets.add(bucketKey)
    rows.push({ capturedAt, value, bucketKey })
  })

  return { rows, skipped }
}
