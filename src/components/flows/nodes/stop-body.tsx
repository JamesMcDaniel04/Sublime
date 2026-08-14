'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

function StopBody({ node: raw, update }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'stop' }>
  return (
    <div className="grid gap-2">
      <label className={labelClass} htmlFor="message">Message</label>
      <input id="message"
        value={node.data.reason ?? ''}
        onChange={(event) => update({ ...node, data: { ...node.data, reason: event.target.value } })}
        className={controlClass}
        placeholder="Optional reason shown when this flow stops"
      />
    </div>
  )
}

// The reason is optional — a bare stop is valid.
export const stopModule: NodeBodyModule = {
  Body: StopBody,
  requiredFields: [],
}
