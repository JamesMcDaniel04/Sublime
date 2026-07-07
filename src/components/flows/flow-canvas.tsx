'use client'

import { Fragment, useState } from 'react'
import { Plus, Bot, Wrench, Globe, GitBranch, Repeat, Rows3, CircleStop } from 'lucide-react'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import type { StepType } from '@/lib/flows/mutate'
import { StepCard, type StepStatus } from './step-card'

const STEP_TYPES: { type: StepType; label: string; icon: typeof Bot }[] = [
  { type: 'agent', label: 'Run agent', icon: Bot },
  { type: 'tool', label: 'Tool call', icon: Wrench },
  { type: 'http', label: 'HTTP request', icon: Globe },
  { type: 'condition', label: 'If / else', icon: GitBranch },
  { type: 'loop', label: 'For each', icon: Repeat },
  { type: 'parallel', label: 'Parallel', icon: Rows3 },
  { type: 'stop', label: 'Stop', icon: CircleStop },
]

/** The + between steps: opens a small type menu instead of assuming "agent". */
function InsertMenu({ onPick, compact }: { onPick: (type: StepType) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex flex-col items-center">
      {!compact && <div className="h-3 w-px bg-border" />}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Insert step"
        className={
          compact
            ? 'flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-300 hover:text-indigo-600'
            : 'flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-1 transition-colors hover:border-indigo-300 hover:text-indigo-600'
        }
      >
        <Plus className="h-3.5 w-3.5" />
        {compact && 'Add step'}
      </button>
      {!compact && <div className="h-3 w-px bg-border" />}
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full z-20 mt-1 w-40 origin-top animate-scale-in rounded-lg border border-border bg-card p-1 shadow-popover">
            {STEP_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onPick(t.type)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <t.icon className="h-3.5 w-3.5 text-muted-foreground" /> {t.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function FlowCanvas({
  graph,
  agentName,
  statusByNode,
  selectedId,
  onSelect,
  onInsertAfter,
  onAppendBranch,
}: {
  graph: FlowGraph
  agentName: (agentId: string) => string
  statusByNode: Record<string, StepStatus>
  selectedId: string | null
  onSelect: (nodeId: string) => void
  onInsertAfter: (afterId: string, type: StepType) => void
  onAppendBranch: (conditionId: string, branch: 'true' | 'false', type: StepType) => void
}) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const nextOf = (id: string): FlowNode | undefined => {
    const edge = graph.edges.find((e) => e.source === id && !e.branch)
    return edge ? byId.get(edge.target) : undefined
  }
  const branchHead = (conditionId: string, branch: 'true' | 'false'): FlowNode | undefined => {
    const edge = graph.edges.find((e) => e.source === conditionId && e.branch === branch)
    return edge ? byId.get(edge.target) : undefined
  }
  // Ids living inside loop bodies / parallel branches render via their container.
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )

  const titleFor = (node: FlowNode): string => {
    switch (node.type) {
      case 'trigger':
        return 'Trigger'
      case 'agent':
        return node.data.label || agentName(node.data.agentId) || 'Agent step'
      case 'condition': {
        const clause = node.data.clauses?.[0] ?? (node.data.left !== undefined ? { left: node.data.left, op: node.data.op, right: node.data.right } : null)
        const extra = (node.data.clauses?.length ?? 1) > 1 ? ` +${node.data.clauses!.length - 1}` : ''
        return node.data.label || (clause ? `If ${clause.left} ${clause.op} ${clause.right}${extra}` : 'If / else')
      }
      case 'loop':
        return node.data.label || 'For each'
      case 'parallel':
        return node.data.label || 'Parallel branches'
      case 'stop':
        return node.data.label || 'Stop'
      case 'tool':
        return node.data.label || node.data.toolName || 'Tool call'
      case 'http':
        return node.data.label || `${node.data.method} ${node.data.url || 'HTTP request'}`
    }
  }
  const subtitleFor = (node: FlowNode): string | undefined => {
    switch (node.type) {
      case 'trigger': {
        const type = (node.data.trigger as { type?: string } | undefined)?.type ?? 'manual'
        return type.charAt(0).toUpperCase() + type.slice(1)
      }
      case 'agent':
        return node.data.note || node.data.input || undefined
      case 'loop':
        return `over ${node.data.over} · ${node.data.concurrency ?? 1} at a time`
      case 'parallel':
        return `${node.data.branches.length} branches`
      case 'stop':
        return node.data.reason || undefined
      case 'tool':
        return node.data.note || node.data.toolName || undefined
      case 'http':
        return node.data.note || undefined
      default:
        return (node.data as { note?: string }).note || undefined
    }
  }

  const card = (node: FlowNode, index?: number) => (
    <StepCard
      index={index}
      type={node.type}
      title={titleFor(node)}
      subtitle={subtitleFor(node)}
      status={statusByNode[node.id]}
      selected={selectedId === node.id}
      onClick={() => onSelect(node.id)}
    />
  )

  const nestedCards = (node: FlowNode) => {
    const ids = node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : []
    const nodes = ids.map((id) => byId.get(id)).filter((n): n is FlowNode => Boolean(n))
    if (!nodes.length) return null
    return (
      <div className="ml-8 mt-1 space-y-1 border-l-2 border-dashed border-indigo-200 pl-3 dark:border-indigo-500/30">
        {nodes.map((body) => (
          <Fragment key={body.id}>{card(body)}</Fragment>
        ))}
      </div>
    )
  }

  // Render a linear chain from `start`. A condition ends the chain and renders
  // its ✓/✗ branch chains indented (recursively), matching engine semantics.
  const renderChain = (start: FlowNode | undefined, depth: number, seen: Set<string>): React.ReactNode => {
    const parts: React.ReactNode[] = []
    let current = start
    while (current && !seen.has(current.id) && !contained.has(current.id)) {
      seen.add(current.id)
      const node = current
      parts.push(
        <Fragment key={node.id}>
          {card(node)}
          {nestedCards(node)}
        </Fragment>,
      )
      if (node.type === 'condition') {
        parts.push(
          <div key={`${node.id}-branches`} className="ml-6 mt-1 space-y-2 border-l-2 border-dashed border-border pl-3">
            {(['true', 'false'] as const).map((branch) => (
              <div key={branch}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {branch === 'true' ? '✓ then' : '✗ otherwise'}
                </p>
                <div className="space-y-1">
                  {renderChain(branchHead(node.id, branch), depth + 1, seen)}
                  <InsertMenu compact onPick={(type) => onAppendBranch(node.id, branch, type)} />
                </div>
              </div>
            ))}
          </div>,
        )
        return parts // the flow continues inside a branch, not below the condition
      }
      const next = nextOf(node.id)
      if (next && !contained.has(next.id) && !seen.has(next.id)) {
        parts.push(<InsertMenu key={`${node.id}-insert`} onPick={(type) => onInsertAfter(node.id, type)} />)
      } else {
        parts.push(
          <div key={`${node.id}-tail`} className="flex flex-col items-center pt-1">
            <div className="h-3 w-px bg-border" />
            <InsertMenu compact onPick={(type) => onInsertAfter(node.id, type)} />
          </div>,
        )
      }
      current = next
    }
    return parts
  }

  const trigger = byId.get('trigger') ?? graph.nodes[0]
  const first = trigger ? nextOf(trigger.id) : undefined
  const seen = new Set<string>(trigger ? [trigger.id] : [])

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col">
      {trigger && card(trigger)}
      {trigger && !first && (
        <div className="flex flex-col items-center pt-1">
          <div className="h-3 w-px bg-border" />
          <InsertMenu compact onPick={(type) => onInsertAfter(trigger.id, type)} />
        </div>
      )}
      {trigger && first && <InsertMenu onPick={(type) => onInsertAfter(trigger.id, type)} />}
      {renderChain(first, 0, seen)}
    </div>
  )
}
