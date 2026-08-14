'use client'

import { cn } from '@/lib/utils'
import { VARIABLE_OPS, VARIABLE_OP_LABELS, VARIABLE_TYPES, VARIABLE_TYPE_LABELS, type FlowNode, type VariableOp, type VariableType } from '@/lib/flows/graph'
import { VARIABLE_VALUE_PLACEHOLDER, variableValueOptional } from '@/lib/flows/step-copy'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, labelClass, tokenControlBase } from './field-primitives'
import { FieldPreview } from './field-preview'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function VariableBody({
  node,
  update,
  tokenWiring,
  variableNames,
  showErrors,
  previewContext,
}: {
  node: Extract<FlowNode, { type: 'variable' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  variableNames?: string[]
  showErrors?: boolean
  previewContext?: NodeBodyProps['previewContext']
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const isInitialize = node.data.op === 'initialize'
  const currentName = node.data.name.trim()
  // Mutation ops pick from variables initialized earlier; keep a name that is
  // not in that list selectable (it may live in a sibling branch).
  const nameOptions = [...(variableNames ?? []), ...(currentName && !(variableNames ?? []).includes(currentName) ? [currentName] : [])]
  const setOp = (op: VariableOp) =>
    update({ ...node, data: { ...node.data, op, varType: op === 'initialize' ? node.data.varType ?? 'string' : undefined } })
  const nameInvalid = Boolean(showErrors && !currentName)
  const valueInvalid = Boolean(showErrors && !variableValueOptional(node.data.op) && !node.data.value?.trim())
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass} htmlFor="operation">Operation</label>
        <select id="operation" value={node.data.op} onChange={(event) => setOp(event.target.value as VariableOp)} className={controlClass}>
          {VARIABLE_OPS.map((op) => (
            <option key={op} value={op}>
              {VARIABLE_OP_LABELS[op]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Name <span className="text-red-500">*</span></label>
        {isInitialize || nameOptions.length === 0 ? (
          <input
            value={node.data.name}
            onChange={(event) => update({ ...node, data: { ...node.data, name: event.target.value } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={cn(controlClass, nameInvalid && 'border-red-400 focus:border-red-500')}
            placeholder="Enter variable name"
            aria-label="Variable name"
          />
        ) : (
          <select
            value={currentName}
            onChange={(event) => update({ ...node, data: { ...node.data, name: event.target.value } })}
            className={cn(controlClass, nameInvalid && 'border-red-400 focus:border-red-500')}
            aria-label="Variable name"
          >
            <option value="">Choose a variable</option>
            {nameOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {!isInitialize && nameOptions.length === 0 && (
          <p className="text-xs text-muted-foreground">No variables are initialized earlier in this flow — add an Initialize variable step first, or type the name it will use.</p>
        )}
      </div>
      {isInitialize && (
        <div className="grid gap-2">
          <label className={labelClass}>Type <span className="text-red-500">*</span></label>
          <select
            value={node.data.varType ?? 'string'}
            onChange={(event) => update({ ...node, data: { ...node.data, varType: event.target.value as VariableType } })}
            className={controlClass}
          >
            {VARIABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {VARIABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid gap-2">
        <label className={labelClass}>
          Value {variableValueOptional(node.data.op) ? <span className="font-normal normal-case text-muted-foreground">(optional)</span> : <span className="text-red-500">*</span>}
        </label>
        <TokenTextEditor
          ref={registerEditor('var.value')}
          value={node.data.value ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('var.value')}
          onChange={(value) => update({ ...node, data: { ...node.data, value } })}
          invalid={valueInvalid}
          className={cn(tokenControlBase, valueInvalid ? 'focus:border-red-500' : 'border-border')}
          placeholder={VARIABLE_VALUE_PLACEHOLDER[node.data.op]}
          ariaLabel="Variable value"
        />
        <FieldPreview value={node.data.value ?? ''} ctx={previewContext} />
      </div>
    </div>
  )
}

// MISSING_VARIABLE_NAME + MISSING_VARIABLE_VALUE in validate.ts.
export const variableModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, variableNames, showErrors, previewContext }: NodeBodyProps) => (
    <VariableBody node={node as Extract<FlowNode, { type: 'variable' }>} update={update} tokenWiring={tokenWiring} variableNames={variableNames} showErrors={showErrors} previewContext={previewContext} />
  ),
  defaultEditorKey: 'var.value',
  requiredFields: ['name'],
}
