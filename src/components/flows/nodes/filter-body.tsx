'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { ConditionBody } from './condition-body'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

/**
 * The Filter step's own params pane.
 *
 * Filter and Condition share a clause editor and nothing else. The registry
 * used to map `filter: conditionModule`, so a Filter rendered Condition's
 * panel — including its "Route the flow based on a rule" framing, which
 * describes branching for a node that keeps or drops items.
 *
 * The behaviour that panel could not express is `splitItems`, and on Filter it
 * is not a detail — it selects between two different nodes:
 *
 *   on  — keep the MATCHING items of the input list; always continue, an
 *         empty result flows on as []
 *   off — a GATE: pass through when the condition holds, otherwise drop (in a
 *         loop) or end the chain
 *
 * With no control it was always off, which meant the Filter node could not
 * filter. It only gated.
 *
 * The clause editor is composed rather than copied — ConditionBody is already
 * exported raw for RepeatUntilBody's stop condition, so this is the
 * established seam.
 */
type FilterNode = Extract<FlowNode, { type: 'filter' }>

function FilterBody({ node, update, tokenWiring, previewContext }: {
  node: FilterNode
  update: (node: FlowNode) => void
  tokenWiring: NodeBodyProps['tokenWiring']
  previewContext?: NodeBodyProps['previewContext']
}) {
  const mode = node.data.splitItems === true ? 'keep' : 'gate'
  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        <label className={labelClass} htmlFor={`${node.id}-filter-mode`}>What this step does</label>
        <select
          id={`${node.id}-filter-mode`}
          aria-label="Filter behaviour"
          className={controlClass}
          value={mode}
          // undefined rather than false when gating: the schema treats the
          // field as optional and advancedParamsSetCount elsewhere counts
          // explicitly-set keys, so writing `false` would report a tuned
          // parameter on an untouched node.
          onChange={(event) =>
            update({
              ...node,
              data: { ...node.data, splitItems: event.target.value === 'keep' ? true : undefined },
            } as FlowNode)
          }
        >
          <option value="keep">Keep the items that match</option>
          <option value="gate">Continue only if the rule is true</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {mode === 'keep'
            ? 'Filters the incoming list. The step always continues — no matches passes on an empty list.'
            : 'Acts as a gate on the whole step. If the rule is false the branch stops here.'}
        </p>
      </div>

      {/* Clause editing is identical to Condition's, so it is composed. */}
      <ConditionBody node={node} update={update} tokenWiring={tokenWiring} previewContext={previewContext} />
    </div>
  )
}

export const filterModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, previewContext }: NodeBodyProps) => (
    <FilterBody node={node as FilterNode} update={update} tokenWiring={tokenWiring} previewContext={previewContext} />
  ),
  defaultEditorKey: 'clause.left',
  requiredFields: ['clauses'],
}
