'use client'

import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, labelClass, tokenControlClass } from './field-primitives'
import { FieldPreview } from './field-preview'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function routerFirstBranch(node: Extract<FlowNode, { type: 'router' }>) {
  return node.data.branches[0] ?? { id: 'branch1', label: '' }
}

function RouterBody({
  node,
  update,
  tokenWiring,
  previewContext,
}: {
  node: Extract<FlowNode, { type: 'router' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  previewContext?: NodeBodyProps['previewContext']
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const branches = node.data.branches.length ? node.data.branches : [routerFirstBranch(node)]
  const setBranches = (next: typeof branches) => update({ ...node, data: { ...node.data, branches: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        An AI model reads the routing input, weighs it against each branch&apos;s description below, and continues down the best match — otherwise the <strong>default</strong> path.
      </p>
      <div className="grid gap-2">
        <label className={labelClass}>Routing input</label>
        <TokenTextEditor
          ref={registerEditor('router.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('router.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          className={cn(tokenControlClass, 'min-w-0')}
          placeholder="The value the AI routes on, e.g. {{trigger.input}}"
          ariaLabel="Routing input"
        />
        <FieldPreview value={node.data.input ?? ''} ctx={previewContext} />
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Routing instructions (optional)</label>
        <TokenTextEditor
          ref={registerEditor('router.instructions')}
          multiline
          rows={3}
          value={node.data.instructions ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('router.instructions')}
          onChange={(instructions) => update({ ...node, data: { ...node.data, instructions: instructions || undefined } })}
          className={tokenControlClass}
          placeholder="Extra guidance for the model making the routing decision"
          ariaLabel="Routing instructions"
        />
      </div>
      <div className="space-y-2">
        {branches.map((branch, index) => (
          <div key={branch.id} className="space-y-2 rounded-lg border border-border p-2.5">
            <div className="flex gap-2">
              <input
                value={branch.label ?? ''}
                placeholder={`Branch ${index + 1} label`}
                onChange={(event) => setBranches(branches.map((b, j) => (j === index ? { ...b, label: event.target.value } : b)))}
                className={cn(controlClass, 'flex-1')}
                aria-label={`Branch ${index + 1} label`}
              />
              {branches.length > 1 && (
                <button
                  type="button"
                  onClick={() => setBranches(branches.filter((_, j) => j !== index))}
                  className="px-1 text-red-500 hover:text-red-700"
                  aria-label={`Remove branch ${index + 1}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            <textarea
              value={branch.description ?? ''}
              onChange={(event) => setBranches(branches.map((b, j) => (j === index ? { ...b, description: event.target.value } : b)))}
              rows={2}
              className={cn(controlClass, 'h-auto w-full min-h-[64px] resize-y py-2')}
              placeholder="What routes here — the AI picks the branch by this description"
              aria-label={`Branch ${index + 1} description`}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          setBranches([...branches, { id: `branch${branches.length + 1}-${Math.random().toString(36).slice(2, 6)}`, label: '', description: '' }])
        }
        className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add branch
      </button>
    </div>
  )
}

// EMPTY_ROUTER in validate.ts requires at least one branch.
export const routerModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, previewContext }: NodeBodyProps) => (
    <RouterBody node={node as Extract<FlowNode, { type: 'router' }>} update={update} tokenWiring={tokenWiring} previewContext={previewContext} />
  ),
  requiredFields: ['branches'],
}
