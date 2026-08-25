/**
 * Declarative node parameters.
 *
 * A node's config panel is hand-written JSX today, which means whether a field
 * appears is an `&&` someone has to remember on every schema change. They did
 * not: three fields shipped that the executor reads and no panel rendered —
 * `data.count` (Limit silently pinned to 10), `data.field` (splitOut had no
 * way to name its list), and `splitItems` (which meant the Filter node could
 * not filter). See docs/parity/2026-08-24-n8n-node-parity.md.
 *
 * n8n avoids that class entirely by making a parameter DATA: an
 * `INodeProperties` entry carrying `displayOptions`, walked by one generic
 * renderer. This is the same idea, scoped to what Sublime needs.
 *
 * SCOPE. Scalar fields only. Composite editors — the clause rows, the
 * field-mapping rows — stay bespoke JSX. n8n models those as `fixedCollection`
 * and it is the least pleasant part of n8n; there is no gain in copying it.
 * What matters is that every scalar key is declared, because those are the
 * ones that go missing.
 *
 * Pure and dependency-free: it runs in the browser next to the renderer and in
 * a unit test with no DOM.
 */

export type ParamControl = 'text' | 'number' | 'select' | 'textarea'

export interface ParamSpec {
  /** The `node.data.<key>` this control edits. */
  key: string
  label: string
  control: ParamControl
  /** Required for `select`; ignored otherwise. */
  options?: { value: string; label: string }[]
  placeholder?: string
  /** Help text under the control. */
  help?: string
  required?: boolean
  /** `number` bounds. Mirror the executor's own clamp — a control that accepts
   *  a value the executor rewrites is worse than no control, because the flow
   *  then runs a number the builder never showed. */
  min?: number
  max?: number
  /**
   * Render only when the node's current values satisfy every entry.
   *
   * n8n's `displayOptions.show` semantics, deliberately:
   *   several keys   → ALL must match (AND)
   *   several values → ANY matches (OR)
   *   omitted        → always visible
   */
  showWhen?: Partial<Record<string, string[]>>
}

/** Compared as strings: values come out of a Json column and are not
 *  guaranteed to be the type the spec was written against. */
const matches = (value: unknown, allowed: string[]): boolean =>
  value != null && allowed.includes(String(value))

/**
 * The specs that should render for a node's current data, in declaration
 * order so the panel does not reshuffle as values change.
 */
export function visibleParams(specs: ParamSpec[], data: Record<string, unknown>): ParamSpec[] {
  return specs.filter((spec) => {
    if (!spec.showWhen) return true
    return Object.entries(spec.showWhen).every(([key, allowed]) =>
      Array.isArray(allowed) ? matches(data[key], allowed) : true,
    )
  })
}
