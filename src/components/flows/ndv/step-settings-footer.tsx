'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { NODE_TYPES, type EditableType } from '../node-types'
import { controlClass, labelClass } from '../nodes/field-primitives'
import type { TokenEditorWiring } from '../nodes/types'

/**
 * Step type + notes, below the params. Lived at the bottom of the expanded
 * canvas card; moved here with the rest of the config surface when the card
 * went summary-only.
 */
export function StepSettingsFooter({
  node,
  update,
  onChangeType,
  tokenWiring,
}: {
  node: FlowNode
  update: (node: FlowNode) => void
  onChangeType?: (type: EditableType) => void
  tokenWiring: TokenEditorWiring
}) {
  const { blockActive, unblockActive } = tokenWiring
  return (
    <div className="mt-4 grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
      {onChangeType && (
        <div className="grid gap-1.5">
          <label className={labelClass}>Step type</label>
          <select value={node.type} onChange={(event) => onChangeType(event.target.value as EditableType)} className={controlClass}>
            {NODE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid gap-1.5">
        <label className={labelClass}>Notes (optional)</label>
        <input
          value={(node.data as { note?: string }).note ?? ''}
          placeholder="Why this step exists, gotchas, links…"
          onFocus={blockActive}
          onBlur={unblockActive}
          onChange={(event) => update({ ...node, data: { ...node.data, note: event.target.value || undefined } } as FlowNode)}
          className={controlClass}
        />
      </div>
    </div>
  )
}
