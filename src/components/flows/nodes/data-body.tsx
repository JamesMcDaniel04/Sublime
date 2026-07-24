'use client'

import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CONDITION_OPS, CONDITION_OP_LABELS, DATA_OPS, type ConditionClause, type ConditionOp, type DataOp, type FlowNode } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { DATA_OP_HELPER, DATA_OP_INPUT_PLACEHOLDER } from '@/lib/flows/step-copy'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, labelClass, tokenControlBase, tokenControlClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function DataBody({
  node,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'data' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const op = node.data.op
  const setOp = (next: DataOp) => {
    // Ops with required list config start with one empty row so the editor
    // opens ready to fill in.
    const clauses = next === 'filterArray' && !(node.data.clauses ?? []).length ? [{ left: '', op: 'contains' as ConditionOp, right: '' }] : node.data.clauses
    const fields = next === 'select' && !(node.data.fields ?? []).length ? [{ name: '', value: '' }] : node.data.fields
    update({ ...node, data: { ...node.data, op: next, clauses, fields } })
  }
  const inputInvalid = Boolean(showErrors && !node.data.input?.trim())
  const clauses = node.data.clauses ?? []
  const fields = node.data.fields ?? []
  const setClauses = (next: ConditionClause[]) => update({ ...node, data: { ...node.data, clauses: next } })
  const setFields = (next: { name: string; value: string }[]) => update({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Operation</label>
        <select value={op} onChange={(event) => setOp(event.target.value as DataOp)} className={controlClass}>
          {DATA_OPS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_OP_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Input <span className="text-red-500">*</span></label>
        <TokenTextEditor
          ref={registerEditor('data.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('data.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          invalid={inputInvalid}
          className={cn(tokenControlBase, inputInvalid ? 'focus:border-red-500' : 'border-border')}
          placeholder={DATA_OP_INPUT_PLACEHOLDER[op]}
          ariaLabel="Input"
        />
      </div>
      {op === 'join' && (
        <div className="grid gap-2">
          <label className={labelClass}>Join with <span className="font-normal normal-case text-muted-foreground">(optional)</span></label>
          <input
            value={node.data.separator ?? ''}
            onChange={(event) => update({ ...node, data: { ...node.data, separator: event.target.value || undefined } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={controlClass}
            placeholder="Defaults to a comma"
            aria-label="Join with"
          />
        </div>
      )}
      {op === 'parseJson' && (
        <div className="grid gap-2">
          <label className={labelClass}>Schema <span className="font-normal normal-case text-muted-foreground">(optional)</span></label>
          <textarea
            rows={4}
            value={node.data.schema ?? ''}
            onChange={(event) => update({ ...node, data: { ...node.data, schema: event.target.value || undefined } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={cn(controlClass, 'h-auto resize-y py-2 font-mono text-xs')}
            placeholder="A JSON Schema describing the parsed shape"
            aria-label="Schema"
          />
          <p className="text-xs text-muted-foreground">Optional — stored for reference.</p>
        </div>
      )}
      {op === 'filterArray' && (
        <div className="grid gap-2">
          <label className={labelClass}>Conditions <span className="text-red-500">*</span></label>
          {(clauses.length ? clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]).map((clause, index, list) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_130px_1fr_36px]">
              <TokenTextEditor
                ref={registerEditor(`data.clause.${index}.left`)}
                value={clause.left}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.clause.${index}.left`)}
                onChange={(left) => setClauses(list.map((entry, j) => (j === index ? { ...entry, left } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Item field to check"
                ariaLabel={`Condition ${index + 1} value`}
              />
              <select
                value={clause.op}
                onChange={(event) => setClauses(list.map((entry, j) => (j === index ? { ...entry, op: event.target.value as ConditionOp } : entry)))}
                className={controlClass}
              >
                {CONDITION_OPS.map((entry) => (
                  <option key={entry} value={entry}>
                    {CONDITION_OP_LABELS[entry]}
                  </option>
                ))}
              </select>
              <TokenTextEditor
                ref={registerEditor(`data.clause.${index}.right`)}
                value={clause.right}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.clause.${index}.right`)}
                onChange={(right) => setClauses(list.map((entry, j) => (j === index ? { ...entry, right } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Compare to"
                ariaLabel={`Condition ${index + 1} comparison value`}
              />
              <button
                type="button"
                onClick={() => setClauses(list.filter((_, j) => j !== index))}
                disabled={list.length === 1}
                className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Remove condition"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setClauses([...(clauses.length ? clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]), { left: '', op: 'contains', right: '' }])}
            className="text-left text-sm font-semibold text-blue-700 hover:text-blue-900"
          >
            Add condition
          </button>
        </div>
      )}
      {op === 'select' && (
        <div className="grid gap-2">
          <label className={labelClass}>Fields <span className="text-red-500">*</span></label>
          {(fields.length ? fields : [{ name: '', value: '' }]).map((field, index, list) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
              <input
                value={field.name}
                onChange={(event) => setFields(list.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                onFocus={blockActive}
                onBlur={unblockActive}
                className={controlClass}
                placeholder="Output field"
              />
              <TokenTextEditor
                ref={registerEditor(`data.field.${index}.value`)}
                value={field.value}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.field.${index}.value`)}
                onChange={(value) => setFields(list.map((entry, j) => (j === index ? { ...entry, value } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Value for this field"
                ariaLabel={`Value for field ${field.name || index + 1}`}
              />
              <button
                type="button"
                onClick={() => setFields(list.filter((_, j) => j !== index))}
                disabled={list.length === 1}
                className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Remove field"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFields([...(fields.length ? fields : [{ name: '', value: '' }]), { name: '', value: '' }])}
            className="text-left text-sm font-semibold text-blue-700 hover:text-blue-900"
          >
            Add field
          </button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{DATA_OP_HELPER[op]}</p>
    </div>
  )
}

// The op always has a value (schema default); its input requirements vary by op.
export const dataModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, showErrors }: NodeBodyProps) => (
    <DataBody node={node as Extract<FlowNode, { type: 'data' }>} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
  ),
  defaultEditorKey: 'data.input',
  requiredFields: ['op'],
}
