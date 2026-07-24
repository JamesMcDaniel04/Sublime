'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { AddStepMenu } from '../add-step-menu'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

function ParallelBody({ node: raw, update, onAddStep }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'parallel' }>
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Runs {node.data.branches.length || 0} branches side by side.</p>
      <div className="grid gap-1.5">
        <label className={labelClass}>Join strategy</label>
        <select
          value={node.data.join ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, join: (event.target.value || undefined) as 'object' | 'array' | 'merge' | undefined } })}
          className={controlClass}
        >
          <option value="">Keyed object (default)</option>
          <option value="object">Object (keyed by labels)</option>
          <option value="array">Array (branch order)</option>
          <option value="merge">Merge (shallow-merge objects)</option>
        </select>
      </div>
      {onAddStep && <AddStepMenu label="Add parallel branch" onPick={onAddStep} />}
    </div>
  )
}

// EMPTY_PARALLEL in validate.ts requires at least one branch.
export const parallelModule: NodeBodyModule = {
  Body: ParallelBody,
  requiredFields: ['branches'],
}
