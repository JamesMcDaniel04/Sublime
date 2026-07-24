/**
 * The shared vocabulary every node body renders with: control classes and the
 * small pure helpers that shape user-typed field values.
 *
 * Extracted verbatim from step-card.tsx so the canvas card and the node detail
 * view render identical inputs. The class strings are load-bearing for
 * tailwind-merge ordering — see the comment on `tokenControlBase`.
 */
import { CalendarDays, FileText, Hash, Mail, ToggleLeft, Type } from 'lucide-react'
import type { OutputField } from '@/lib/flows/graph'
import type { InputKind, InputTypeDescriptor, KeyValueRow } from './types'

export const INPUT_TYPES: InputTypeDescriptor[] = [
  { id: 'text', label: 'Text', description: 'Please enter your input', name: 'text', fieldType: 'string', icon: Type, tone: 'bg-purple-500 text-white' },
  { id: 'yesno', label: 'Yes / No', description: 'Choose yes or no.', name: 'yesNo', fieldType: 'boolean', icon: ToggleLeft, tone: 'bg-foreground text-background' },
  { id: 'file', label: 'File', description: 'Upload or provide file data.', name: 'file', fieldType: 'object', icon: FileText, tone: 'bg-foreground text-background' },
  { id: 'email', label: 'Email', description: 'Enter an email address.', name: 'email', fieldType: 'string', icon: Mail, tone: 'bg-green-600 text-white' },
  { id: 'number', label: 'Number', description: 'Enter a number.', name: 'number', fieldType: 'number', icon: Hash, tone: 'bg-orange-500 text-white' },
  { id: 'date', label: 'Date', description: 'Enter a date.', name: 'date', fieldType: 'string', icon: CalendarDays, tone: 'bg-rose-500 text-white' },
]

export const controlClass =
  'h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-muted-foreground/50 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
// TokenTextEditor overrides that restyle the drawer-flavored defaults to match
// the card's denser slate inputs. No border color here — `invalid` red borders
// (appended after this string) must win in tailwind-merge order.
export const tokenControlBase =
  'min-h-10 rounded-md bg-background px-3 py-2 text-sm text-foreground transition-colors empty:before:text-muted-foreground hover:border-muted-foreground/50 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
export const tokenControlClass = `${tokenControlBase} border-border`
export const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function inputTypeForField(field: OutputField): InputTypeDescriptor {
  const text = `${field.name} ${field.description ?? ''}`.toLowerCase()
  if (field.type === 'boolean') return INPUT_TYPES.find((type) => type.id === 'yesno')!
  if (field.type === 'number') return INPUT_TYPES.find((type) => type.id === 'number')!
  if (text.includes('email')) return INPUT_TYPES.find((type) => type.id === 'email')!
  if (text.includes('date')) return INPUT_TYPES.find((type) => type.id === 'date')!
  if (field.type === 'object' || field.type === 'array' || text.includes('file')) return INPUT_TYPES.find((type) => type.id === 'file')!
  return INPUT_TYPES.find((type) => type.id === 'text')!
}

export function uniqueFieldName(base: string, fields: OutputField[]): string {
  const names = new Set(fields.map((field) => field.name))
  if (!names.has(base)) return base
  let index = 2
  while (names.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}

export function parseKeyValueRows(value?: string): KeyValueRow[] {
  if (!value?.trim()) return [{ key: '', value: '' }]
  try {
    const parsed = JSON.parse(value)
    if (isRecord(parsed)) {
      const rows = Object.entries(parsed).map(([key, raw]) => ({
        key,
        value: typeof raw === 'string' ? raw : JSON.stringify(raw),
      }))
      return rows.length ? rows : [{ key: '', value: '' }]
    }
  } catch {
    return [{ key: '', value }]
  }
  return [{ key: '', value }]
}

export function serializeKeyValueRows(rows: KeyValueRow[]): string {
  const entries = rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value] as const)
  if (!entries.length) return ''
  return JSON.stringify(Object.fromEntries(entries), null, 2)
}

export function stopEvent(event: React.MouseEvent | React.FocusEvent) {
  event.stopPropagation()
}

export type { InputKind }
