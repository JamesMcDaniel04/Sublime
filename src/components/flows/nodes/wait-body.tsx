'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

function WaitBody({ node: raw, update }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'wait' }>
  return <div className="grid grid-cols-2 gap-2">
    <label className={labelClass}>Amount<input className={controlClass} type="number" min={0} value={node.data.amount} onChange={(event) => update({ ...node, data: { ...node.data, amount: Number(event.target.value) } })} /></label>
    <label className={labelClass}>Unit<select className={controlClass} value={node.data.unit} onChange={(event) => update({ ...node, data: { ...node.data, unit: event.target.value as typeof node.data.unit } })}><option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label>
  </div>
}

// amount and unit both carry schema defaults.
export const waitModule: NodeBodyModule = {
  Body: WaitBody,
  requiredFields: [],
}
