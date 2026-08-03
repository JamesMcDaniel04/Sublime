'use client'

import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FIELD_TYPES, type FlowNode, type OutputFieldBinding } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, labelClass, tokenControlClass } from './field-primitives'
import { FieldPreview } from './field-preview'
import type { NodeBodyModule, NodeBodyProps } from './types'

function OutputBody({ node: raw, update, tokenWiring, previewContext }: NodeBodyProps) {
  const node = raw as Extract<FlowNode, { type: 'output' }>
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const fields = node.data.fields
  const setFields = (next: OutputFieldBinding[]) => update({ ...node, data: { ...node.data, fields: next } })
  const patchField = (index: number, patch: Partial<OutputFieldBinding>) =>
    setFields(fields.map((field, current) => (current === index ? { ...field, ...patch } : field)))

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Build the typed object returned to a caller or parent workflow.</p>
      {fields.map((field, index) => (
        <div key={index} className="space-y-2 rounded-lg border border-border p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_130px_36px]">
            <input
              value={field.name}
              onChange={(event) => patchField(index, { name: event.target.value })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              placeholder="resultField"
              aria-label={`Output ${index + 1} name`}
            />
            <select
              value={field.type}
              onChange={(event) => patchField(index, { type: event.target.value as OutputFieldBinding['type'] })}
              className={controlClass}
              aria-label={`Output ${index + 1} type`}
            >
              {FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <button
              type="button"
              onClick={() => setFields(fields.filter((_, current) => current !== index))}
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600"
              aria-label={`Remove output ${field.name || index + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <label className={labelClass}>Value</label>
          <TokenTextEditor
            ref={registerEditor(`output.${index}.value`)}
            value={field.value}
            labelCtx={labelCtx}
            onFocus={focusEditor(`output.${index}.value`)}
            onChange={(value) => patchField(index, { value })}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="{{steps.previous.output}}"
            ariaLabel={`Value for output ${field.name || index + 1}`}
          />
          <FieldPreview value={field.value} ctx={previewContext} />
          <label className={labelClass}>Description
            <input
              value={field.description ?? ''}
              onChange={(event) => patchField(index, { description: event.target.value || undefined })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={`${controlClass} mt-1 w-full`}
              placeholder="What this result means"
            />
          </label>
        </div>
      ))}
      {!fields.length && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">No explicit output yet. The workflow currently returns the last step&apos;s output.</p>}
      <button
        type="button"
        onClick={() => setFields([...fields, { name: '', type: 'any', value: '' }])}
        className="text-sm font-semibold text-blue-700 hover:text-blue-900"
      >
        Add output field
      </button>
    </div>
  )
}

export const outputModule: NodeBodyModule = {
  Body: OutputBody,
  defaultEditorKey: 'output.0.value',
  requiredFields: [],
}
