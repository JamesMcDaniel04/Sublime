'use client'

import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CONDITION_OPS, CONDITION_OP_LABELS, type ConditionOp, type FlowNode } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, tokenControlClass } from './field-primitives'
import { FieldPreview } from './field-preview'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function switchFirstCase(node: Extract<FlowNode, { type: 'switch' }>) {
  return node.data.cases[0] ?? { id: 'case1', left: '', op: 'contains' as ConditionOp, right: '' }
}

function SwitchBody({
  node,
  update,
  tokenWiring,
  previewContext,
}: {
  node: Extract<FlowNode, { type: 'switch' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  previewContext?: NodeBodyProps['previewContext']
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const cases = node.data.cases.length ? node.data.cases : [switchFirstCase(node)]
  const setCases = (next: typeof cases) => update({ ...node, data: { ...node.data, cases: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Route to the first matching case, otherwise use the default path.</p>
      {cases.map((c, index) => (
        <div key={c.id} className="space-y-2 rounded-lg border border-border p-2.5">
          <div className="flex gap-2">
            <input
              value={c.label ?? ''}
              placeholder={`Case ${index + 1} label`}
              onChange={(event) => setCases(cases.map((x, j) => (j === index ? { ...x, label: event.target.value } : x)))}
              className={cn(controlClass, 'flex-1')}
              aria-label={`Case ${index + 1} label`}
            />
            {cases.length > 1 && (
              <button
                type="button"
                onClick={() => setCases(cases.filter((_, j) => j !== index))}
                className="px-1 text-red-500 hover:text-red-700"
                aria-label={`Remove case ${index + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_150px_1fr]">
            <TokenTextEditor
              ref={registerEditor(`sw.${index}.left`)}
              value={c.left}
              labelCtx={labelCtx}
              onFocus={focusEditor(`sw.${index}.left`)}
              onChange={(left) => setCases(cases.map((x, j) => (j === index ? { ...x, left } : x)))}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Field or value"
              ariaLabel={`Case ${index + 1} value`}
            />
            <FieldPreview value={c.left} ctx={previewContext} />
            <select
              value={c.op}
              onChange={(event) => setCases(cases.map((x, j) => (j === index ? { ...x, op: event.target.value as ConditionOp } : x)))}
              className={controlClass}
            >
              {CONDITION_OPS.map((op) => (
                <option key={op} value={op}>
                  {CONDITION_OP_LABELS[op]}
                </option>
              ))}
            </select>
            <TokenTextEditor
              ref={registerEditor(`sw.${index}.right`)}
              value={c.right}
              labelCtx={labelCtx}
              onFocus={focusEditor(`sw.${index}.right`)}
              onChange={(right) => setCases(cases.map((x, j) => (j === index ? { ...x, right } : x)))}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Compare to"
              ariaLabel={`Case ${index + 1} comparison`}
            />
            <FieldPreview value={c.right} ctx={previewContext} />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setCases([...cases, { id: `case${cases.length + 1}-${Math.random().toString(36).slice(2, 6)}`, left: '', op: 'contains', right: '' }])
        }
        className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add case
      </button>
    </div>
  )
}

// EMPTY_SWITCH in validate.ts requires at least one case.
export const switchModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, previewContext }: NodeBodyProps) => (
    <SwitchBody node={node as Extract<FlowNode, { type: 'switch' }>} update={update} tokenWiring={tokenWiring} previewContext={previewContext} />
  ),
  defaultEditorKey: 'sw.left',
  requiredFields: ['cases'],
}
