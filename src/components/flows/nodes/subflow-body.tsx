'use client'

import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { flowGraphSchema, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { inputParamsFromGraph, outputFieldsFromGraph } from '@/lib/flows/flow-tool'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, labelClass, tokenControlClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

type FlowChoice = { id: string; name: string; graph: FlowGraph }

function parsedObject(value: string | undefined): { valid: boolean; value?: Record<string, unknown> } {
  if (!value?.trim()) return { valid: true, value: {} }
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { valid: true, value: parsed as Record<string, unknown> }
      : { valid: false }
  } catch {
    return { valid: false }
  }
}

function SubflowBody({ node: raw, flowId: currentFlowId, update, tokenWiring, showErrors }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'subflow' }>
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const [flows, setFlows] = useState<FlowChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/flows', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || 'Could not load workflows')
        const choices = (Array.isArray(body.flows) ? body.flows : []).flatMap((flow: { id?: unknown; name?: unknown; graph?: unknown }) => {
          const graph = flowGraphSchema.safeParse(flow.graph)
          return typeof flow.id === 'string' && typeof flow.name === 'string' && flow.id !== currentFlowId && graph.success
            ? [{ id: flow.id, name: flow.name, graph: graph.data }]
            : []
        })
        if (active) setFlows(choices)
      })
      .catch(() => {
        if (active) setLoadFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [currentFlowId])

  const selected = useMemo(() => flows.find((flow) => flow.id === node.data.flowId), [flows, node.data.flowId])
  const params = selected ? inputParamsFromGraph(selected.graph) : []
  const inputState = parsedObject(node.data.input)
  const chooseFlow = (nextFlowId: string) => {
    const choice = flows.find((flow) => flow.id === nextFlowId)
    if (!choice) {
      update({ ...node, data: { ...node.data, flowId: nextFlowId, outputFields: undefined } })
      return
    }
    const childParams = inputParamsFromGraph(choice.graph)
    const suggestedInput = Object.fromEntries(childParams.map((param) => [param.name, `{{input.${param.name}}}`]))
    update({
      ...node,
      data: {
        ...node.data,
        flowId: choice.id,
        input: childParams.length ? JSON.stringify(suggestedInput, null, 2) : undefined,
        outputFields: outputFieldsFromGraph(choice.graph),
      },
    })
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        <label className={labelClass}>Workflow <span className="text-red-500">*</span></label>
        <select
          className={cn(controlClass, showErrors && !node.data.flowId.trim() && 'border-red-400 focus:border-red-500')}
          value={node.data.flowId}
          onChange={(event) => chooseFlow(event.target.value)}
          disabled={loading}
        >
          <option value="">{loading ? 'Loading workflows…' : 'Choose a workflow'}</option>
          {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}
          {node.data.flowId && !selected && <option value={node.data.flowId}>Unavailable workflow ({node.data.flowId})</option>}
        </select>
        {loadFailed && <p className="text-xs text-red-600">Workflows could not be loaded. Reopen this step to retry.</p>}
      </div>

      {selected && (
        <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          {params.length
            ? <>Expected inputs: {params.map((param) => `${param.name}${param.required ? ' (required)' : ''}: ${param.type ?? 'string'}`).join(', ')}</>
            : 'This workflow declares no typed inputs.'}
        </div>
      )}

      <div className="grid gap-2">
        <label className={labelClass}>Inputs (JSON object)</label>
        <TokenTextEditor
          ref={registerEditor('subflow.input')}
          multiline
          rows={6}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('subflow.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input: input || undefined } })}
          invalid={!inputState.valid}
          className={cn(tokenControlClass, !inputState.valid && 'border-red-400 focus:border-red-500')}
          placeholder={'{"customer":"{{input.customer}}"}'}
          ariaLabel="Child workflow inputs"
        />
        {!inputState.valid && <p className="text-xs text-red-600">Inputs must be a valid JSON object.</p>}
        {params.filter((param) => param.required && !(param.name in (inputState.value ?? {}))).map((param) => (
          <p key={param.name} className="text-xs text-amber-700">Required child input &quot;{param.name}&quot; is not mapped.</p>
        ))}
      </div>
    </div>
  )
}

export const subflowModule: NodeBodyModule = {
  Body: SubflowBody,
  defaultEditorKey: 'subflow.input',
  requiredFields: ['flowId'],
}

export { parsedObject }
