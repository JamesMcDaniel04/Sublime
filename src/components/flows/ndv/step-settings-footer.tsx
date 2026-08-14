'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { controlClass, labelClass } from '../nodes/field-primitives'
import type { TokenEditorWiring } from '../nodes/types'

/**
 * Per-step notes. The step-type selector that used to live here is gone: a
 * node's type is what the node is, and converting one in place was a rarely
 * correct escape hatch — delete and re-add instead.
 */
export function StepSettingsFooter({
  node,
  update,
  tokenWiring,
}: {
  node: FlowNode
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { blockActive, unblockActive } = tokenWiring
  return (
    <div className="grid gap-1.5">
      <label className={labelClass} htmlFor="notes-optional">Notes (optional)</label>
      <input id="notes-optional"
        value={(node.data as { note?: string }).note ?? ''}
        placeholder="Why this step exists, gotchas, links…"
        onFocus={blockActive}
        onBlur={unblockActive}
        onChange={(event) => update({ ...node, data: { ...node.data, note: event.target.value || undefined } } as FlowNode)}
        className={controlClass}
      />
    </div>
  )
}
