'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { ParamFields } from './param-fields'
import { MERGE_PARAMS } from '@/lib/flows/merge-params'
import type { NodeBodyModule, NodeBodyProps } from './types'

/**
 * The Merge step's params pane.
 *
 * First node built on the declarative manifest rather than hand-written JSX —
 * every field here is a `MERGE_PARAMS` entry with a `showWhen`, so the join
 * keys appear for `byKey` and nowhere else without an `&&` anyone has to
 * remember. That is the whole point of node-params.ts: the three unreachable
 * config bugs found this session were all a field the executor read and a
 * panel forgot.
 *
 * The body is this thin because there is nothing composite to edit — no
 * clause rows, no name/value mappings. A node whose config is entirely scalar
 * needs no bespoke component at all, which is the case the manifest is for.
 */
type MergeNode = Extract<FlowNode, { type: 'merge' }>

function MergeBody({ node, update, tokenWiring }: {
  node: MergeNode
  update: (node: FlowNode) => void
  tokenWiring: NodeBodyProps['tokenWiring']
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Joins two incoming branches into one result. Wire both branches into this step.
      </p>
      <ParamFields
        specs={MERGE_PARAMS}
        data={node.data as unknown as Record<string, unknown>}
        nodeId={node.id}
        onPatch={(patch: Record<string, unknown>) => update({ ...node, data: { ...node.data, ...patch } } as FlowNode)}
        onFocusText={tokenWiring.blockActive}
        onBlurText={tokenWiring.unblockActive}
      />
    </div>
  )
}

export const mergeModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring }: NodeBodyProps) => (
    <MergeBody node={node as MergeNode} update={update} tokenWiring={tokenWiring} />
  ),
  defaultEditorKey: 'leftKey',
  requiredFields: [],
}
