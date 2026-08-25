/**
 * Shape an arbitrary tool result into a small table for the resource picker.
 *
 * Items come back from a live connection, so their shape is not ours to
 * assume: a channel list is objects, a tag list may be bare strings, and a
 * poorly-behaved tool can return a mix of both. Everything here degrades to
 * "render something useful" rather than throwing inside a dropdown.
 */

/** Most columns the picker will show — an identifier and a label, not a payload. */
const MAX_HEADERS = 6

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** The column a primitive item is filed under, since it has no field name. */
const PRIMITIVE_KEY = 'value'

/** Render one cell: empty for nullish, JSON for nested, String otherwise. */
function cell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      // Circular structures reach here; the picker still needs a cell.
      return '[unserializable]'
    }
  }
  return String(value)
}

export interface PickerTable {
  headers: string[]
  rows: Record<string, string>[]
}

export function pickerRows(items: unknown[]): PickerTable {
  if (items.length === 0) return { headers: [], rows: [] }

  const rows = items.map((item) =>
    isRecord(item)
      ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, cell(value)]))
      : { [PRIMITIVE_KEY]: cell(item) },
  )

  // Union rather than the first row's keys: results are routinely sparse, and
  // a field absent from item 0 is still worth a column.
  const headers: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key)
    }
  }

  return { headers: headers.slice(0, MAX_HEADERS), rows }
}
