'use client'

import { Trash2 } from 'lucide-react'
import { CONDITION_OPS, CONDITION_OP_LABELS, type ConditionClause, type ConditionOp } from '@/lib/flows/graph'

export type TriggerFilter = { match?: 'all' | 'any'; clauses?: ConditionClause[] }

// Defaults match the drawer's styling; the card passes its own slate/blue
// classes so the editor blends into either surface.
const DEFAULT_LABEL_CLASS = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'
const DEFAULT_FIELD_CLASS =
  'rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const DEFAULT_ADD_CLASS = 'mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800'
const DEFAULT_HELPER_CLASS = 'mt-1 text-xs text-muted-foreground'

/**
 * "Only run when…" — optional trigger-level filter. A run whose trigger
 * payload fails these clauses is skipped before any step executes (see
 * interpretFlow). Empty clause list = no filter (the stored `filter` is
 * dropped so old graphs stay byte-identical).
 */
export function TriggerFilterEditor({
  filter,
  onChange,
  labelClass = DEFAULT_LABEL_CLASS,
  fieldClass = DEFAULT_FIELD_CLASS,
  addButtonClass = DEFAULT_ADD_CLASS,
  helperClass = DEFAULT_HELPER_CLASS,
}: {
  filter: TriggerFilter | undefined
  onChange: (filter: TriggerFilter | undefined) => void
  labelClass?: string
  fieldClass?: string
  addButtonClass?: string
  helperClass?: string
}) {
  const clauses = filter?.clauses ?? []
  const update = (next: ConditionClause[]) =>
    onChange(next.length ? { match: filter?.match ?? 'all', clauses: next } : undefined)
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className={labelClass}>Only run when…</label>
        {clauses.length > 1 && (
          <select
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
            value={filter?.match ?? 'all'}
            onChange={(e) => onChange({ match: e.target.value as 'all' | 'any', clauses })}
            aria-label="Match all or any filter conditions"
          >
            <option value="all">All match</option>
            <option value="any">Any match</option>
          </select>
        )}
      </div>
      {clauses.map((clause, i) => (
        <div key={i} className="mt-1.5 flex items-center gap-1.5">
          <input
            className={fieldClass}
            value={clause.left}
            placeholder="{{trigger.input.status}}"
            onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, left: e.target.value } : c)))}
            aria-label={`Filter ${i + 1} value`}
          />
          <select
            className={fieldClass}
            value={clause.op}
            onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}
            aria-label={`Filter ${i + 1} operator`}
          >
            {CONDITION_OPS.map((op) => (
              <option key={op} value={op}>
                {CONDITION_OP_LABELS[op]}
              </option>
            ))}
          </select>
          <input
            className={fieldClass}
            value={clause.right}
            placeholder="urgent"
            onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, right: e.target.value } : c)))}
            aria-label={`Filter ${i + 1} comparison`}
          />
          <button
            type="button"
            onClick={() => update(clauses.filter((_, j) => j !== i))}
            className="px-1 text-red-500 hover:text-red-700"
            aria-label="Remove filter condition"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={addButtonClass}
        onClick={() => update([...clauses, { left: '', op: 'eq', right: '' }])}
      >
        + Add condition
      </button>
      <p className={helperClass}>
        Runs that don&apos;t match are skipped before any step executes.
      </p>
    </div>
  )
}
