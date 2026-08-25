/**
 * Form trigger — a way for someone OUTSIDE the workspace to start a flow.
 *
 * Every other trigger is internal (manual, schedule, signal, activity), a
 * machine-to-machine webhook, or a poll. There was no way to hand a person a
 * link and collect typed input, which is what n8n's Form trigger is for and
 * the single most-missed way to start a flow.
 *
 * Deliberately built on what already exists: `input` nodes declare typed
 * params, and `missingRequiredInputFields` already validates them. This is
 * derivation and coercion, not new machinery.
 *
 * **Coercion is the substance.** An HTML form submits strings. Without this a
 * field declared `number` reaches the flow as `"42"`, and every downstream
 * comparison silently does the wrong thing — the kind of bug that surfaces as
 * "the flow ran but the branch was wrong" weeks later.
 */
import type { FlowGraph, InputParam } from './graph'

export interface FormField {
  name: string
  type: InputParam['type']
  required: boolean
  description?: string
  /** Prefilled value, when the input node declares one. */
  defaultValue?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/**
 * The fields a form should render for this flow.
 *
 * Read off the flow's `input` nodes, so the form and the run agree on the
 * contract by construction — a flow author declares inputs once and the public
 * form follows. A malformed graph yields nothing rather than throwing: this
 * feeds a PUBLIC page, and a stored graph can predate the current schema.
 */
export function formFieldsFor(graph: FlowGraph): FormField[] {
  const nodes = isRecord(graph) ? (graph as { nodes?: unknown }).nodes : null
  if (!Array.isArray(nodes)) return []

  const fields: FormField[] = []
  for (const node of nodes) {
    if (!isRecord(node) || node.type !== 'input') continue
    const params = isRecord(node.data) ? (node.data as { params?: unknown }).params : null
    if (!Array.isArray(params)) continue
    for (const param of params) {
      if (!isRecord(param)) continue
      const name = typeof param.name === 'string' ? param.name.trim() : ''
      // An unnamed field cannot be rendered or submitted; carrying it would
      // put an unlabelled input on a public page.
      if (!name) continue
      fields.push({
        name,
        type: (param.type as InputParam['type']) ?? 'string',
        required: param.required === true,
        ...(typeof param.description === 'string' && param.description ? { description: param.description } : {}),
        ...(typeof param.default === 'string' && param.default ? { defaultValue: param.default } : {}),
      })
    }
  }
  return fields
}

export type CoerceResult =
  | { values: Record<string, unknown> }
  | { errors: string[] }

/** True for "the user did not answer", where `0` and `false` are answers. */
const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

/** What a form actually posts for a checkbox or a select. */
function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '').trim().toLowerCase()
  // 'on' is what an unvalued checked checkbox posts.
  return text === 'true' || text === 'on' || text === 'yes' || text === '1'
}

/**
 * Validate and coerce a submission against the declared fields.
 *
 * Only DECLARED fields survive. A public endpoint receives whatever it is
 * sent, and passing extra keys through would turn the form into an arbitrary
 * payload injector aimed at the flow's context.
 */
export function coerceFormSubmission(fields: FormField[], body: unknown): CoerceResult {
  const submitted = isRecord(body) ? body : {}
  const values: Record<string, unknown> = {}
  const errors: string[] = []

  for (const field of fields) {
    const raw = submitted[field.name]

    if (isBlank(raw)) {
      // A BOOLEAN is the exception: an unchecked checkbox posts nothing at all,
      // so absence IS the answer "no". Leaving the key out instead would make
      // every flow reading it compare against undefined, and `{{input.urgent}}`
      // would render empty rather than "false".
      if (field.type === 'boolean') {
        values[field.name] = false
        continue
      }
      // For every other type, `0` and `false` are answers rather than absence —
      // isBlank already treats them as present, which is the classic form bug
      // this comment exists to stop reappearing.
      if (field.required) errors.push(`"${field.name}" is required.`)
      continue
    }

    if (field.type === 'number') {
      const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(parsed)) {
        errors.push(`"${field.name}" must be a number.`)
        continue
      }
      values[field.name] = parsed
      continue
    }

    if (field.type === 'boolean') {
      values[field.name] = toBoolean(raw)
      continue
    }

    if (field.type === 'object' || field.type === 'array') {
      if (typeof raw !== 'string') {
        values[field.name] = raw
        continue
      }
      try {
        values[field.name] = JSON.parse(raw)
      } catch {
        errors.push(`"${field.name}" must be valid JSON.`)
      }
      continue
    }

    values[field.name] = typeof raw === 'string' ? raw : String(raw)
  }

  return errors.length > 0 ? { errors } : { values }
}
