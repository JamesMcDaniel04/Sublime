'use client'

import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, tokenControlClass } from './field-primitives'
import { FieldPreview } from './field-preview'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function transformFields(node: Extract<FlowNode, { type: 'transform' }>): { name: string; value: string }[] {
  return node.data.fields.length ? node.data.fields : [{ name: '', value: '' }]
}

function TransformBody({
  node,
  update,
  tokenWiring,
  previewContext,
}: {
  node: Extract<FlowNode, { type: 'transform' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  previewContext?: NodeBodyProps['previewContext']
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const fields = transformFields(node)
  const setFields = (next: typeof fields) => update({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Create a clean object for later steps.</p>
      {fields.map((field, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
          <input
            value={field.name}
            onChange={(event) => setFields(fields.map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, name: event.target.value } : entry)))}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={controlClass}
            placeholder="Output field"
          />
          <TokenTextEditor
            ref={registerEditor(`xf.${index}`)}
            value={field.value}
            labelCtx={labelCtx}
            onFocus={focusEditor(`xf.${index}`)}
            onChange={(value) => setFields(fields.map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, value } : entry)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Value"
            ariaLabel={`Value for field ${field.name || index + 1}`}
          />
          <FieldPreview value={field.value} ctx={previewContext} />
          <button
            type="button"
            onClick={() => setFields(fields.filter((_, fieldIndex) => fieldIndex !== index))}
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600"
            aria-label="Remove field"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setFields([...fields, { name: '', value: '' }])} className="text-sm font-semibold text-blue-700 hover:text-blue-900">
        Add field
      </button>
    </div>
  )
}

// EMPTY_TRANSFORM in validate.ts requires at least one field.
export const transformModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, previewContext }: NodeBodyProps) => (
    <TransformBody node={node as Extract<FlowNode, { type: 'transform' }>} update={update} tokenWiring={tokenWiring} previewContext={previewContext} />
  ),
  defaultEditorKey: 'xf.0',
  requiredFields: ['fields'],
}
