'use client'

import { Trash2 } from 'lucide-react'
import { FIELD_TYPES, type FlowNode, type InputParam } from '@/lib/flows/graph'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

function InputBody({ node: raw, update, tokenWiring }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'input' }>
  const { blockActive, unblockActive } = tokenWiring
  const params = node.data.params ?? []
  const setParams = (next: InputParam[]) => update({ ...node, data: { ...node.data, params: next } })
  const patchParam = (index: number, patch: Partial<InputParam>) =>
    setParams(params.map((param, current) => (current === index ? { ...param, ...patch } : param)))

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Declare the named, typed values a person, webhook, agent, or parent workflow may pass in.</p>
      {params.map((param, index) => (
        <div key={index} className="space-y-2 rounded-lg border border-border p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_130px_36px]">
            <input
              value={param.name}
              onChange={(event) => patchParam(index, { name: event.target.value })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              placeholder="parameterName"
              aria-label={`Input ${index + 1} name`}
            />
            <select
              value={param.type}
              onChange={(event) => patchParam(index, { type: event.target.value as InputParam['type'] })}
              className={controlClass}
              aria-label={`Input ${index + 1} type`}
            >
              {FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <button
              type="button"
              onClick={() => setParams(params.filter((_, current) => current !== index))}
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600"
              aria-label={`Remove input ${param.name || index + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={labelClass}>Default
              <input
                value={param.default ?? ''}
                onChange={(event) => patchParam(index, { default: event.target.value || undefined })}
                onFocus={blockActive}
                onBlur={unblockActive}
                className={`${controlClass} mt-1 w-full`}
                placeholder="Optional fallback"
              />
            </label>
            <label className={labelClass}>Description
              <input
                value={param.description ?? ''}
                onChange={(event) => patchParam(index, { description: event.target.value || undefined })}
                onFocus={blockActive}
                onBlur={unblockActive}
                className={`${controlClass} mt-1 w-full`}
                placeholder="What callers should provide"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={param.required === true}
              onChange={(event) => patchParam(index, { required: event.target.checked || undefined })}
            />
            Required when no default is available
          </label>
        </div>
      ))}
      {!params.length && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">No inputs yet. This workflow currently accepts the existing untyped trigger payload.</p>}
      <button
        type="button"
        onClick={() => setParams([...params, { name: '', type: 'string' }])}
        className="text-sm font-semibold text-blue-700 hover:text-blue-900"
      >
        Add input
      </button>
    </div>
  )
}

export const inputModule: NodeBodyModule = {
  Body: InputBody,
  requiredFields: [],
}
