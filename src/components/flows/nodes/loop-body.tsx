'use client'

import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { AddStepMenu } from '../add-step-menu'
import type { EditableType } from '../node-types'
import { controlClass, tokenControlClass } from './field-primitives'
import { FieldPreview } from './field-preview'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function LoopBody({
  node,
  update,
  tokenWiring,
  onAddStep,
  previewContext,
}: {
  node: Extract<FlowNode, { type: 'loop' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  onAddStep?: (type: EditableType, branchIndex?: number) => void
  previewContext?: NodeBodyProps['previewContext']
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const usesTriggerInput = node.data.over === '{{trigger.input}}'
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Run the steps inside this loop once for each item in a list.</p>
      <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
        <select
          value={usesTriggerInput ? 'trigger' : 'custom'}
          onChange={(event) => update({ ...node, data: { ...node.data, over: event.target.value === 'trigger' ? '{{trigger.input}}' : '' } })}
          className={controlClass}
        >
          <option value="trigger">Trigger input</option>
          <option value="custom">Custom list</option>
        </select>
        {usesTriggerInput ? (
          <input value="" readOnly className={controlClass} placeholder="Uses trigger input" disabled aria-label="Items to process" />
        ) : (
          <div className="grid gap-1">
            <TokenTextEditor
              ref={registerEditor('loop.over')}
              value={node.data.over}
              labelCtx={labelCtx}
              onFocus={focusEditor('loop.over')}
              onChange={(over) => update({ ...node, data: { ...node.data, over } })}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Comma-separated list, JSON array, or mapped list"
              ariaLabel="Items to process"
            />
            <FieldPreview value={node.data.over} ctx={previewContext} />
          </div>
        )}
      </div>
      {onAddStep && <AddStepMenu label="Add step to loop" onPick={onAddStep} />}
    </div>
  )
}

// MISSING_LOOP_SOURCE + EMPTY_LOOP_BODY in validate.ts.
export const loopModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, onAddStep, previewContext }: NodeBodyProps) => (
    <LoopBody node={node as Extract<FlowNode, { type: 'loop' }>} update={update} tokenWiring={tokenWiring} onAddStep={onAddStep} previewContext={previewContext} />
  ),
  defaultEditorKey: 'loop.over',
  requiredFields: ['over', 'body'],
}
