import type { OutputField } from '@/lib/flows/graph'

/** A node in the datatree field picker: a mappable value + its child fields. */
export type DataField = {
  label: string
  token: string
  type: string
  children?: DataField[]
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Infer the field tree from an actual value (e.g. a step's last-run output).
 * `basePath` is a dot-path without braces (e.g. "step.n1.output"). Bounded depth
 * so deeply-nested or recursive data can't explode the tree.
 */
export function inferFields(value: unknown, basePath: string, depth = 0): DataField[] {
  if (depth > 3 || value == null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    const sample = value[0]
    if (sample === undefined) return []
    return [
      {
        label: '[0]',
        token: `{{${basePath}.0}}`,
        type: typeOf(sample),
        children: inferFields(sample, `${basePath}.0`, depth + 1),
      },
    ]
  }
  return Object.entries(value as Record<string, unknown>).map(([key, val]) => ({
    label: key,
    token: `{{${basePath}.${key}}}`,
    type: typeOf(val),
    children: inferFields(val, `${basePath}.${key}`, depth + 1),
  }))
}

export type DataTreeSource = {
  /** Upstream steps available to map from, nearest last. */
  upstream: { id: string; label: string; outputFields?: OutputField[] }[]
  /** Include the trigger input root (default true). */
  trigger?: boolean
  /** Inside a loop body: expose {{item}} and {{loop.index}}. */
  insideLoop?: boolean
  /** Parsed last-run outputs keyed by node id — fields are inferred from them. */
  lastOutputs?: Record<string, unknown>
}

/** Build the datatree roots for the field picker. */
export function buildDataTree(source: DataTreeSource): DataField[] {
  const roots: DataField[] = []
  if (source.trigger !== false) roots.push({ label: 'Trigger input', token: '{{trigger.input}}', type: 'string' })
  if (source.insideLoop) {
    const item = source.lastOutputs?.__item
    roots.push({ label: 'item (current)', token: '{{item}}', type: typeOf(item), children: inferFields(item, 'item') })
    roots.push({ label: 'loop.index', token: '{{loop.index}}', type: 'number' })
  }
  for (const step of source.upstream) {
    const basePath = `step.${step.id}.output`
    const children: DataField[] = []
    for (const field of step.outputFields ?? []) {
      children.push({ label: field.name, token: `{{${basePath}.${field.name}}}`, type: field.type })
    }
    const observed = source.lastOutputs?.[step.id]
    if (observed && typeof observed === 'object') {
      for (const inferred of inferFields(observed, basePath)) {
        if (!children.some((c) => c.label === inferred.label)) children.push(inferred)
      }
    }
    roots.push({ label: step.label, token: `{{${basePath}}}`, type: 'object', children: children.length ? children : undefined })
  }
  return roots
}
