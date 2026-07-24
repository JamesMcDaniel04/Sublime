'use client'

import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CONDITION_OPS, CONDITION_OP_LABELS, type ConditionClause, type ConditionOp, type FlowNode } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, tokenControlClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function firstClause(node: Extract<FlowNode, { type: 'condition' | 'filter' }>): ConditionClause {
  if (node.data.clauses?.[0]) return node.data.clauses[0]
  if (node.type === 'condition') {
    return { left: node.data.left ?? '', op: node.data.op ?? 'contains', right: node.data.right ?? '' }
  }
  return { left: '', op: 'contains', right: '' }
}

/**
 * Exported raw (not just as a module) because RepeatUntilBody composes it to
 * edit its stop condition with the same clause editor.
 */
export function ConditionBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'condition' | 'filter' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  // All clauses (legacy single left/op/right normalizes to one row).
  const clauses: ConditionClause[] = node.data.clauses?.length ? node.data.clauses : [firstClause(node)]
  const setClauses = (next: ConditionClause[]) =>
    update({ ...node, data: { ...node.data, clauses: next, match: node.data.match ?? 'all', left: undefined, op: undefined, right: undefined } } as FlowNode)
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{node.type === 'condition' ? 'Route the flow based on a rule.' : 'Continue only when this rule is true.'}</p>
        {clauses.length > 1 && (
          <select
            value={node.data.match ?? 'all'}
            onChange={(event) => update({ ...node, data: { ...node.data, match: event.target.value as 'all' | 'any', clauses } } as FlowNode)}
            className={cn(controlClass, 'w-auto py-1 text-xs')}
            aria-label="Match all or any rules"
          >
            <option value="all">All match</option>
            <option value="any">Any match</option>
          </select>
        )}
      </div>
      {clauses.map((clause, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_150px_1fr_auto]">
          <TokenTextEditor
            ref={registerEditor(`clause.${index}.left`)}
            value={clause.left}
            labelCtx={labelCtx}
            onFocus={focusEditor(`clause.${index}.left`)}
            onChange={(left) => setClauses(clauses.map((c, j) => (j === index ? { ...c, left } : c)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Field or value"
            ariaLabel={`Rule ${index + 1} field or value`}
          />
          <select
            value={clause.op}
            onChange={(event) => setClauses(clauses.map((c, j) => (j === index ? { ...c, op: event.target.value as ConditionOp } : c)))}
            className={controlClass}
          >
            {CONDITION_OPS.map((op) => (
              <option key={op} value={op}>
                {CONDITION_OP_LABELS[op]}
              </option>
            ))}
          </select>
          <TokenTextEditor
            ref={registerEditor(`clause.${index}.right`)}
            value={clause.right}
            labelCtx={labelCtx}
            onFocus={focusEditor(`clause.${index}.right`)}
            onChange={(right) => setClauses(clauses.map((c, j) => (j === index ? { ...c, right } : c)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Compare to"
            ariaLabel={`Rule ${index + 1} comparison`}
          />
          {clauses.length > 1 ? (
            <button
              type="button"
              onClick={() => setClauses(clauses.filter((_, j) => j !== index))}
              className="self-center px-1 text-red-500 hover:text-red-700"
              aria-label={`Remove rule ${index + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => setClauses([...clauses, { left: '', op: 'contains', right: '' }])}
        className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add rule
      </button>
    </div>
  )
}

// Registered under BOTH 'condition' and 'filter' — they shared one body in the
// old switch, and two copies would be two places to fix a clause-editor bug.
// EMPTY_CONDITION in validate.ts makes clauses the one required key.
export const conditionModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring }: NodeBodyProps) => (
    <ConditionBody node={node as Extract<FlowNode, { type: 'condition' | 'filter' }>} update={update} tokenWiring={tokenWiring} />
  ),
  defaultEditorKey: 'clause.left',
  requiredFields: ['clauses'],
}
