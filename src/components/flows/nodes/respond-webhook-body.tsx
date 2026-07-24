'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

function RespondWebhookBody({ node: raw, update }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'respondWebhook' }>
  return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-2">
      <label className={labelClass}>Status code<input className={controlClass} type="number" min={100} max={599} value={node.data.statusCode} onChange={(event) => update({ ...node, data: { ...node.data, statusCode: Number(event.target.value) } })} /></label>
      <label className={labelClass}>Body type<select className={controlClass} value={node.data.bodyMode} onChange={(event) => update({ ...node, data: { ...node.data, bodyMode: event.target.value as typeof node.data.bodyMode } })}><option value="json">JSON</option><option value="text">Text</option><option value="binary">Binary (base64)</option><option value="none">No body</option></select></label>
    </div>
    <label className={labelClass}>Headers (JSON)<textarea className={controlClass} rows={2} value={node.data.headers ?? ''} onChange={(event) => update({ ...node, data: { ...node.data, headers: event.target.value } })} placeholder={'{"x-result":"ok"}'} /></label>
    {node.data.bodyMode !== 'none' && <label className={labelClass}>Response body<textarea className={controlClass} rows={4} value={node.data.body ?? ''} onChange={(event) => update({ ...node, data: { ...node.data, body: event.target.value } })} placeholder="{{step.previous.output}}" /></label>}
  </div>
}

// statusCode and bodyMode carry schema defaults, so there is nothing the user
// must supply for this step to run.
export const respondWebhookModule: NodeBodyModule = {
  Body: RespondWebhookBody,
  requiredFields: [],
}
