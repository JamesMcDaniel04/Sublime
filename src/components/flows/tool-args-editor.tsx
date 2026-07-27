'use client'

import { useState } from 'react'
import { Code2, ListTree } from 'lucide-react'
import type { FlowContext } from '@/features/flows/context'
import { FieldPreview } from './nodes/field-preview'
import { TokenTextEditor } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'

type JsonSchema = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  default?: unknown
}

export type SchemaField = { name: string; type: string; required: boolean; description?: string; enumValues?: string[]; defaultValue?: unknown }

/** Flatten nested JSON-schema leaves into dot-path form fields. */
export function schemaFields(inputSchema: unknown): SchemaField[] {
  const schema = inputSchema as JsonSchema | null
  if (!schema?.properties) return []
  const walk = (current: JsonSchema, prefix = '', ancestorRequired = true): SchemaField[] => {
    const required = new Set(current.required ?? [])
    return Object.entries(current.properties ?? {}).flatMap(([name, raw]) => {
      const prop = raw.oneOf?.[0] ?? raw.anyOf?.[0] ?? raw
      const path = prefix ? `${prefix}.${name}` : name
      const isRequired = ancestorRequired && required.has(name)
      if (prop.properties) return walk(prop, path, isRequired)
      const type = Array.isArray(prop.type) ? prop.type.find((entry) => entry !== 'null') ?? 'any' : prop.type ?? (prop.enum ? 'string' : 'any')
      const defaultValue = raw.default ?? prop.default
      return [{ name: path, type, required: isRequired, description: raw.description ?? prop.description, enumValues: Array.isArray(raw.enum ?? prop.enum) ? (raw.enum ?? prop.enum)!.map(String) : undefined, ...(defaultValue !== undefined ? { defaultValue } : {}) }]
    })
  }
  return walk(schema)
}

export function parseArgs(args: string | undefined): Record<string, string> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) out[key] = typeof value === 'string' ? value : JSON.stringify(value)
      return out
    }
  } catch {
    /* not JSON yet */
  }
  return {}
}

function parseJsonLike(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (!/^(?:true|false|null|-?\d|\{|\[|")/.test(trimmed)) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function isJsonValueField(field: SchemaField): boolean {
  return ['object', 'array', 'any'].includes(field.type)
}

/** Re-serialize form values to a JSON args string, coercing where the schema says so. */
export function serializeArgs(values: Record<string, string>, fields: SchemaField[]): string {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name]
    if (raw === undefined || raw === '') continue
    const parsed = isJsonValueField(field) ? parseJsonLike(raw) : undefined
    if (parsed !== undefined) {
      setPath(out, field.name, parsed)
    } else if (raw.includes('{{')) {
      // Exact-token object/array values are preserved by resolveTemplateValue at runtime.
      setPath(out, field.name, raw)
    } else if (field.type === 'number' || field.type === 'integer') {
      const n = Number(raw)
      setPath(out, field.name, Number.isNaN(n) ? raw : n)
    } else if (field.type === 'boolean') {
      setPath(out, field.name, raw === 'true')
    } else {
      setPath(out, field.name, raw)
    }
  }
  return JSON.stringify(out, null, 2)
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const existing = cursor[parts[index]]
    cursor = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : (cursor[parts[index]] = {}) as Record<string, unknown>
  }
  cursor[parts.at(-1)!] = value
}

function placeholderFor(field: SchemaField): string {
  if (field.description) return field.description
  if (field.type === 'object') return '{"id": "abc123"} or a whole record from an upstream step'
  if (field.type === 'array') return '["one", "two"] or a list from an upstream step'
  if (field.type === 'any') return 'Text, JSON, or a value from an upstream step'
  return 'Add a value or choose one below'
}

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/**
 * Renders a tool's arguments from its JSON-schema as real form fields, or
 * falls back to a raw-JSON editor for tools whose schema is unknown or when
 * the user opts into advanced mode.
 *
 * Tokens come from the NDV's input pane, which inserts into whichever field
 * has the caret — this editor no longer carries its own picker.
 */
export function ToolArgsEditor({
  inputSchema,
  args,
  onChange,
  labelCtx,
  previewContext,
}: {
  inputSchema: unknown
  args: string | undefined
  onChange: (nextArgs: string) => void
  labelCtx: TokenLabelContext
  /** Sample data for the per-arg resolved-value preview. */
  previewContext?: FlowContext
}) {
  const fields = schemaFields(inputSchema)
  const [raw, setRaw] = useState(fields.length === 0)

  const values = parseArgs(args)
  if (args) {
    try {
      const parsed = JSON.parse(args) as unknown
      for (const field of fields) {
        if (!field.name.includes('.')) continue
        const value = field.name.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined, parsed)
        if (value !== undefined) values[field.name] = typeof value === 'string' ? value : JSON.stringify(value)
      }
    } catch { /* raw editor handles invalid JSON */ }
  }
  const setValue = (name: string, value: string) => onChange(serializeArgs({ ...values, [name]: value }, fields))
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className={`${labelClass} mb-0`}>Arguments</label>
        {fields.length > 0 && (
          <button
            type="button"
            onClick={() => setRaw((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-indigo-600"
          >
            {raw ? <ListTree className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
            {raw ? 'Form' : 'Raw JSON'}
          </button>
        )}
      </div>

      {raw || fields.length === 0 ? (
        <div className="space-y-2">
          <textarea
            rows={5}
            className={`${fieldClass} min-h-[120px] resize-y font-mono text-xs`}
            value={args ?? '{}'}
            placeholder={'{"query": "Click a value in the Input pane to map it"}'}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((field) => (
            <div key={field.name}>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                <span className="font-mono">{field.name}</span>
                {field.required && <span className="text-red-500">*</span>}
                <span className="text-[10px] uppercase text-muted-foreground">{field.type}</span>
              </label>
              {field.enumValues ? (
                <select
                  className={fieldClass}
                  value={values[field.name] ?? (field.defaultValue === undefined ? '' : String(field.defaultValue))}
                  onChange={(e) => setValue(field.name, e.target.value)}
                >
                  <option value="">—</option>
                  {field.enumValues.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : field.type === 'boolean' ? (
                <select
                  className={fieldClass}
                  value={values[field.name] ?? (field.defaultValue === undefined ? '' : String(field.defaultValue))}
                  onChange={(e) => setValue(field.name, e.target.value)}
                >
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : isJsonValueField(field) ? (
                <TokenTextEditor
                  multiline
                  rows={field.type === 'array' || field.type === 'object' ? 4 : 2}
                  className="font-mono text-xs"
                  value={values[field.name] ?? (field.defaultValue === undefined ? '' : typeof field.defaultValue === 'string' ? field.defaultValue : JSON.stringify(field.defaultValue))}
                  labelCtx={labelCtx}
                  placeholder={placeholderFor(field)}
                  onChange={(value) => setValue(field.name, value)}
                  ariaLabel={`Argument ${field.name}`}
                />
              ) : (
                <TokenTextEditor
                  value={values[field.name] ?? (field.defaultValue === undefined ? '' : String(field.defaultValue))}
                  labelCtx={labelCtx}
                  placeholder={placeholderFor(field)}
                  onChange={(value) => setValue(field.name, value)}
                  ariaLabel={`Argument ${field.name}`}
                />
              )}
              {field.description && <p className="mt-0.5 text-[11px] text-muted-foreground">{field.description}</p>}
              <FieldPreview value={values[field.name] ?? ''} ctx={previewContext} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
