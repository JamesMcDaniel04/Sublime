'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { AddStepMenu } from '../add-step-menu'
import type { EditableType } from '../node-types'
import { ConditionBody } from './condition-body'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function RepeatUntilBody({ node, update, tokenWiring, onAddStep }: { node: Extract<FlowNode, { type: 'repeatUntil' }>; update: (node: FlowNode) => void; tokenWiring: TokenEditorWiring; onAddStep?: (type: EditableType) => void }) {
  return <div className="space-y-3">
    <ConditionBody node={{ id: node.id, type: 'condition', data: { clauses: node.data.clauses, match: node.data.match } }} update={(updated) => updated.type === 'condition' && update({ ...node, data: { ...node.data, clauses: updated.data.clauses ?? [], match: updated.data.match } })} tokenWiring={tokenWiring} />
    <div className="grid grid-cols-2 gap-2"><label className={labelClass}>Maximum runs<input className={controlClass} type="number" min={1} max={1000} value={node.data.maxIterations} onChange={(event) => update({ ...node, data: { ...node.data, maxIterations: Number(event.target.value) } })} /></label><label className={labelClass}>Delay (ms)<input className={controlClass} type="number" min={0} max={60000} value={node.data.delayMs ?? 0} onChange={(event) => update({ ...node, data: { ...node.data, delayMs: Number(event.target.value) } })} /></label></div>
    {onAddStep && <AddStepMenu label="Add repeated step" onPick={onAddStep} />}
  </div>
}

// EMPTY_REPEAT_BODY + EMPTY_REPEAT_CONDITION in validate.ts.
export const repeatUntilModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, onAddStep }: NodeBodyProps) => (
    <RepeatUntilBody node={node as Extract<FlowNode, { type: 'repeatUntil' }>} update={update} tokenWiring={tokenWiring} onAddStep={onAddStep} />
  ),
  requiredFields: ['body', 'clauses'],
}
