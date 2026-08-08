import type { FieldType } from '@/lib/flows/graph'
import { asStructured } from '@/features/flows/context'

export type InputParamSpec = { name: string; type?: FieldType; required?: boolean; default?: string }
export type InputSources = { user?: Record<string, unknown>; webhook?: Record<string, unknown> }
export type OutputBindingSpec = { name: string; type?: FieldType; value: string }

const asText = (value: unknown): string =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** A value is "present" when it is not undefined/null and not a blank string. */
const present = (value: unknown): boolean =>
  value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * Coerce a boundary value to a declared FieldType. Mirrors the variable-step
 * coercion (interpret.ts:coerceVariableValue) but over the datatree FieldType
 * vocabulary (string|number|boolean|object|array|any). Returns a plain-english
 * error the run panel can surface.
 */
export function coerceFieldValue(type: FieldType, value: unknown): { value: unknown } | { error: string } {
  const text = typeof value === 'string' ? value.trim() : undefined
  switch (type) {
    case 'any':
      return { value: typeof value === 'string' ? asStructured(value) : value }
    case 'string':
      return { value: value == null ? '' : typeof value === 'string' ? value : asText(value) }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(text)
      if (text !== '' && text !== undefined && Number.isFinite(n)) return { value: n }
      if (typeof value === 'number' && Number.isFinite(value)) return { value }
      return { error: `expected a number but got "${asText(value)}".` }
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { value }
      if (text?.toLowerCase() === 'true') return { value: true }
      if (text?.toLowerCase() === 'false') return { value: false }
      return { error: `expected true or false but got "${asText(value)}".` }
    }
    case 'object': {
      const parsed = typeof value === 'string' ? safeJson(text ?? '') : value
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed }
      return { error: 'expected a JSON object.' }
    }
    case 'array': {
      const parsed = typeof value === 'string' ? safeJson(text ?? '') : value
      if (Array.isArray(parsed)) return { value: parsed }
      return { error: 'expected a JSON array.' }
    }
  }
}

/**
 * Resolve an input node's params against its sources with precedence
 * user > webhook > default, coercing each to its declared type. A required
 * param with no value anywhere is an error; an optional one is omitted.
 */
export function resolveInputParams(
  params: InputParamSpec[],
  sources: InputSources,
): { values: Record<string, unknown> } | { error: string } {
  const user = asRecord(sources.user)
  const webhook = asRecord(sources.webhook)
  const values: Record<string, unknown> = {}
  for (const param of params) {
    const name = param.name.trim()
    if (!name) continue
    let raw: unknown = present(user?.[name]) ? user![name] : present(webhook?.[name]) ? webhook![name] : undefined
    if (!present(raw)) raw = present(param.default) ? param.default : undefined
    if (!present(raw)) {
      if (param.required) return { error: `Missing required input "${name}".` }
      continue
    }
    const coerced = coerceFieldValue(param.type ?? 'string', raw)
    if ('error' in coerced) return { error: `Input "${name}": ${coerced.error}` }
    values[name] = coerced.value
  }
  return { values }
}

/**
 * Bind an output node's fields into the flow's typed return object. `resolve`
 * evaluates a field's template against the flow context (the interpreter passes
 * `(t) => resolveTemplateValue(t, ctx)`); each result is coerced to `type`.
 */
export async function bindOutputFields(
  fields: OutputBindingSpec[],
  resolve: (template: string) => unknown | Promise<unknown>,
): Promise<{ output: Record<string, unknown> } | { error: string }> {
  const output: Record<string, unknown> = {}
  for (const field of fields) {
    const name = field.name.trim()
    if (!name) continue
    const coerced = coerceFieldValue(field.type ?? 'any', await resolve(field.value))
    if ('error' in coerced) return { error: `Output "${name}": ${coerced.error}` }
    output[name] = coerced.value
  }
  return { output }
}
