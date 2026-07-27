'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { containerChildIds, isContainerNode, siblingsOf } from '@/lib/flows/containers'
import { StepCard } from '../step-card'
import type { NodeBodyProps } from './types'

/** `NodeIssues` is a local alias in dag-canvas, so borrow StepCard's own type. */
export type StepCardIssues = React.ComponentProps<typeof StepCard>['issues']

/**
 * A container's children, listed and drag-reorderable, inside the NDV.
 *
 * This moved out of the canvas side-panel when a click started opening the
 * NDV directly: it was the one thing that panel could do that the NDV could
 * not, and dropping it would have silently removed reordering.
 */
export function ContainerChildren({
  node,
  graph,
  labelOf,
  issuesByNode,
  readOnly = false,
  onOpenNode,
  onChangeNode,
  onReorderContainer,
}: {
  node: FlowNode
  graph: FlowGraph
  labelOf: (node: FlowNode) => string
  issuesByNode?: Record<string, StepCardIssues>
  readOnly?: boolean
  onOpenNode?: (id: string) => void
  onChangeNode: (node: FlowNode) => void
  onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const byId = useMemo(() => new Map(graph.nodes.map((entry) => [entry.id, entry])), [graph.nodes])
  if (!isContainerNode(node)) return null

  const children = containerChildIds(node)
    .map((id) => byId.get(id))
    .filter((child): child is FlowNode => Boolean(child))
  if (children.length === 0) return null

  return (
    <div className="space-y-2 rounded-2xl border border-dashed border-border bg-card/70 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Steps inside</p>
      {children.map((child) => {
        const { list, branchIndex } = siblingsOf(node, child.id)
        return (
          <div
            key={child.id}
            data-testid={`container-child-${child.id}`}
            draggable={!readOnly}
            onDragStart={(event) => {
              setDragId(child.id)
              event.dataTransfer.setData('text/flow-node-id', child.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(event) => {
              // Only a sibling from the SAME list may drop here — a parallel
              // branch never reorders into another branch.
              const dragged = dragId ?? event.dataTransfer.getData('text/flow-node-id')
              if (dragged && dragged !== child.id && list.includes(dragged)) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }
            }}
            onDrop={(event) => {
              const dragged = event.dataTransfer.getData('text/flow-node-id')
              if (dragged && dragged !== child.id && list.includes(dragged)) {
                event.preventDefault()
                onReorderContainer?.(node.id, list.indexOf(dragged), list.indexOf(child.id), branchIndex)
              }
              setDragId(null)
            }}
            className={cn('rounded-xl transition-opacity', dragId === child.id && 'opacity-50')}
          >
            <StepCard
              node={child}
              title={labelOf(child)}
              issues={issuesByNode?.[child.id]}
              selected={false}
              labelCtx={{} as never}
              draggable={!readOnly}
              onChange={readOnly ? () => {} : onChangeNode}
              onClick={() => onOpenNode?.(child.id)}
              onOpen={!readOnly && onOpenNode ? () => onOpenNode(child.id) : undefined}
            />
          </div>
        )
      })}
    </div>
  )
}

/**
 * Adapter for node bodies, which receive one prop bag. Renders nothing when
 * the page did not supply graph wiring (the canvas preview path, and every
 * test that mounts a body in isolation).
 */
export function ContainerSteps(props: NodeBodyProps) {
  if (!props.graph || !props.labelOf) return null
  return (
    <ContainerChildren
      node={props.node}
      graph={props.graph}
      labelOf={props.labelOf}
      issuesByNode={props.issuesByNode}
      onOpenNode={props.onOpenNode}
      onChangeNode={props.update}
      onReorderContainer={props.onReorderContainer}
    />
  )
}
