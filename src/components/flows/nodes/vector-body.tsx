'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { ParamFields } from './param-fields'
import { VECTOR_PARAMS } from '@/lib/flows/vector-params'
import type { NodeBodyModule, NodeBodyProps } from './types'

/**
 * The Vector step's params pane.
 *
 * Built on the declarative manifest for the same reason Merge is: every field
 * and every visibility rule is a `VECTOR_PARAMS` entry, so a search shows a
 * query and an upsert shows the documents, with no `&&` anyone has to
 * remember. Adding a mode later means adding entries rather than editing this
 * file.
 */
type VectorNode = Extract<FlowNode, { type: 'vector' }>

function VectorBody({ node, update, tokenWiring }: {
  node: VectorNode
  update: (node: FlowNode) => void
  tokenWiring: NodeBodyProps['tokenWiring']
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Searches or updates a collection of documents in this workspace, matched by meaning rather than keywords.
      </p>
      <ParamFields
        specs={VECTOR_PARAMS}
        data={node.data as unknown as Record<string, unknown>}
        nodeId={node.id}
        onPatch={(patch: Record<string, unknown>) => update({ ...node, data: { ...node.data, ...patch } } as FlowNode)}
        onFocusText={tokenWiring.blockActive}
        onBlurText={tokenWiring.unblockActive}
      />
    </div>
  )
}

export const vectorModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring }: NodeBodyProps) => (
    <VectorBody node={node as VectorNode} update={update} tokenWiring={tokenWiring} />
  ),
  defaultEditorKey: 'query',
  requiredFields: [],
}
