'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

function SubflowBody({ node: raw, update }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'subflow' }>
  return <div className="space-y-3"><label className={labelClass}>Workflow ID<input className={controlClass} value={node.data.flowId} onChange={(event) => update({ ...node, data: { ...node.data, flowId: event.target.value } })} /></label><label className={labelClass}>Inputs (JSON)<textarea className={controlClass} rows={4} value={node.data.input ?? ''} onChange={(event) => update({ ...node, data: { ...node.data, input: event.target.value } })} placeholder={'{"customer":"{{trigger.input.customer}}"}'} /></label></div>
}

// flowId is schema-required with no default and can still be blank.
export const subflowModule: NodeBodyModule = {
  Body: SubflowBody,
  requiredFields: ['flowId'],
}
