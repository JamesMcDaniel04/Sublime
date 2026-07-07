'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Play, Save, Sparkles, Loader2, ListChecks, Undo2, Redo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { emptyGraph, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { insertNodeAfter, appendToBranch, duplicateNode, updateNode, deleteNode, changeNodeType, addContainerStep } from '@/lib/flows/mutate'
import { buildDataTree } from '@/lib/flows/datatree'
import { FlowCanvas } from '@/components/flows/flow-canvas'
import { StepDrawer, type ToolCatalog } from '@/components/flows/step-drawer'
import { CopilotPanel } from '@/components/flows/copilot-panel'
import { RunPanel, type FlowRunDetail } from '@/components/flows/run-panel'
import type { StepStatus } from '@/components/flows/step-card'

type Agent = { id: string; title: string }

/** Ordered main-chain ids from the trigger, for upstream-token help. */
function spineIds(graph: FlowGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const nextId = (node: FlowNode): string | undefined => {
    const edges = graph.edges.filter((e) => e.source === node.id)
    return (node.type === 'condition' ? edges.find((e) => e.branch === 'true') ?? edges[0] : edges[0])?.target
  }
  const ids: string[] = []
  const seen = new Set<string>()
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    ids.push(current.id)
    const next = nextId(current)
    current = next ? byId.get(next) : undefined
  }
  return ids
}

export default function FlowBuilder() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [name, setName] = useState('')
  const [graph, setGraph] = useState<FlowGraph>(emptyGraph())
  const [status, setStatus] = useState('draft')
  const [version, setVersion] = useState(1)
  const [published, setPublished] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<'build' | 'test'>('build')
  const [showCopilot, setShowCopilot] = useState(false)
  const [showRuns, setShowRuns] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusByNode, setStatusByNode] = useState<Record<string, StepStatus>>({})
  const [testInput, setTestInput] = useState('')
  const [runs, setRuns] = useState<{ id: string; status: string; startedAt?: string }[]>([])
  const [selectedRun, setSelectedRun] = useState<FlowRunDetail | null>(null)
  const [toolCatalog, setToolCatalog] = useState<ToolCatalog>([])
  // Serialized snapshot of the last-saved state, for the unsaved-changes dot.
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dirty = savedSnapshot !== '' && JSON.stringify({ name, graph, status }) !== savedSnapshot

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/flows', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([flowsData, agentsData]) => {
        if (cancelled) return
        const flow = (flowsData.flows || []).find((f: { id: string }) => f.id === id)
        if (flow) {
          const g = flow.graph && flow.graph.nodes ? flow.graph : emptyGraph()
          setName(flow.name)
          setGraph(g)
          setStatus(flow.status)
          setVersion(flow.version ?? 1)
          setPublished(Boolean(flow.published))
          setSavedSnapshot(JSON.stringify({ name: flow.name, graph: g, status: flow.status }))
        }
        setAgents(agentsData.success ? agentsData.agents.map((a: Agent) => ({ id: a.id, title: a.title })) : [])
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    // The tool catalog loads separately — discovery can be slow and must not
    // block the canvas paint.
    fetch('/api/flows/tool-catalog', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.success) setToolCatalog(data.connections)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Undo/redo history over structural graph edits (not per-keystroke field edits).
  const undoStack = useRef<FlowGraph[]>([])
  const redoStack = useRef<FlowGraph[]>([])
  const commitGraph = useCallback(
    (next: FlowGraph) => {
      undoStack.current.push(graph)
      if (undoStack.current.length > 50) undoStack.current.shift()
      redoStack.current = []
      setGraph(next)
    },
    [graph],
  )
  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(graph)
    setGraph(prev)
    setSelectedId(null)
  }, [graph])
  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(graph)
    setGraph(next)
    setSelectedId(null)
  }, [graph])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a.title])), [agents])
  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null
  const insideLoop = useMemo(
    () => graph.nodes.some((n) => n.type === 'loop' && n.data.body.includes(selectedId ?? '')),
    [graph, selectedId],
  )
  const upstreamIds = useMemo(() => {
    const ids = spineIds(graph)
    const idx = ids.indexOf(selectedId ?? '')
    return (idx > 0 ? ids.slice(1, idx) : ids.slice(1)).filter((x) => x !== selectedId)
  }, [graph, selectedId])

  // The datatree of mappable upstream data — declared output fields plus fields
  // inferred from the latest run's actual output.
  const dataFields = useMemo(() => {
    if (!selectedNode || selectedNode.type === 'trigger') return []
    const tryParse = (value: unknown) => {
      if (typeof value !== 'string') return value
      const t = value.trim()
      if (!t || (t[0] !== '{' && t[0] !== '[')) return value
      try {
        return JSON.parse(t)
      } catch {
        return value
      }
    }
    const lastOutputs: Record<string, unknown> = {}
    for (const step of selectedRun?.steps ?? []) lastOutputs[step.nodeId] = tryParse(step.output)
    const upstream = upstreamIds.map((uid) => {
      const n = graph.nodes.find((x) => x.id === uid)
      const label =
        n?.type === 'agent'
          ? n.data.label || agentsById.get(n.data.agentId) || 'Agent step'
          : n?.type === 'tool'
            ? n.data.label || n.data.toolName || 'Tool call'
            : n?.type === 'http'
              ? n.data.label || `${n.data.method} request`
              : n
                ? n.type
                : uid
      const outputFields =
        n?.type === 'agent' || n?.type === 'tool' || n?.type === 'http' ? n.data.outputFields : undefined
      return { id: uid, label, outputFields }
    })
    return buildDataTree({ upstream, insideLoop, lastOutputs })
  }, [selectedNode, upstreamIds, graph, selectedRun, insideLoop, agentsById])

  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, graph, status: status.toUpperCase() }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not save the flow.')
        return false
      }
      setSavedSnapshot(JSON.stringify({ name, graph, status }))
      return true
    } finally {
      setSaving(false)
    }
  }, [id, name, graph, status])

  const publish = useCallback(
    async (revert = false) => {
      setPublishing(true)
      try {
        if (!revert && !(await save())) return
        const response = await fetch(`/api/flows/${id}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revert }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          toast.error(data.error || 'Could not publish.')
          return
        }
        if (revert && data.flow?.graph) setGraph(data.flow.graph)
        setVersion(data.flow?.version ?? version)
        setPublished(Boolean(data.flow?.published))
        toast.success(revert ? 'Reverted to the published version.' : `Published v${data.flow?.version}.`)
      } finally {
        setPublishing(false)
      }
    },
    [id, save, version],
  )

  const pollRuns = useCallback(() => {
    const tick = async () => {
      const data = await fetch(`/api/flows/${id}/runs`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      if (data?.runs) setRuns(data.runs.map((r: { id: string; status: string; startedAt?: string }) => ({ id: r.id, status: r.status, startedAt: r.startedAt })))
      const latest = data?.latest as FlowRunDetail | null
      if (!latest) return
      setSelectedRun(latest)
      const map: Record<string, StepStatus> = {}
      for (const step of latest.steps as { nodeId: string; status: StepStatus }[]) map[step.nodeId] = step.status
      setStatusByNode(map)
      if (['succeeded', 'failed'].includes(latest.status) && pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(tick, 2000)
    tick()
  }, [id])

  const selectRun = useCallback(
    async (runId: string) => {
      const data = await fetch(`/api/flows/${id}/runs`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      const found = (data?.runs as FlowRunDetail[] | undefined)?.find((r) => r.id === runId)
      if (found) setSelectedRun(found)
    },
    [id],
  )

  const run = useCallback(async () => {
    setRunning(true)
    setMode('test')
    setShowRuns(true)
    setStatusByNode({})
    try {
      if (!(await save())) return
      pollRuns()
      const response = await fetch(`/api/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: testInput }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) toast.error(data.error || 'Run failed.')
      else if (data.run?.status === 'waiting') toast('The flow paused for input on a step.')
      else if (data.run?.status === 'failed') toast.error('The flow failed — check the step statuses.')
      else toast.success('Flow ran.')
      pollRuns()
    } finally {
      setRunning(false)
    }
  }, [id, save, pollRuns, testInput])

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-3">
          <Skeleton className="h-8 w-64 rounded-lg" />
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="mx-auto h-96 max-w-xl rounded-xl" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" onClick={() => router.push('/flows')} aria-label="Back to flows">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-base font-semibold outline-none hover:bg-muted focus:bg-muted"
          placeholder="Untitled flow"
        />
        <Button variant="ghost" size="icon" onClick={undo} aria-label="Undo" title="Undo (⌘Z)">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={redo} aria-label="Redo" title="Redo (⌘⇧Z)">
          <Redo2 className="h-4 w-4" />
        </Button>
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(['build', 'test'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn('px-3 py-1.5 text-xs font-medium capitalize', mode === m ? 'bg-indigo-600 text-white' : 'text-muted-foreground hover:bg-muted')}
            >
              {m}
            </button>
          ))}
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none"
        >
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <input
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder="Test input…"
          title="Value passed to {{trigger.input}} on Run"
          className="w-40 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
        />
        <Button variant="outline" size="sm" onClick={() => setShowRuns((v) => !v)}>
          <ListChecks className="mr-1.5 h-4 w-4" /> Runs
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowCopilot((v) => !v)}>
          <Sparkles className="mr-1.5 h-4 w-4" /> Copilot
        </Button>
        <Button variant="outline" size="sm" onClick={save} loading={saving} className="relative">
          <Save className="mr-1.5 h-4 w-4" /> Save
          {dirty && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-400" title="Unsaved changes" />}
        </Button>
        <Button variant="outline" size="sm" onClick={() => publish(false)} loading={publishing} title={published ? `Published v${version}` : 'Not yet published'}>
          {published ? `Publish v${version + 1}` : 'Publish'}
        </Button>
        {published && (
          <Button variant="ghost" size="sm" onClick={() => publish(true)} title="Discard draft changes and restore the published version">
            Revert
          </Button>
        )}
        <Button size="sm" onClick={run} disabled={running}>
          {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />} Run
        </Button>
      </div>

      {/* Body: canvas + optional drawer + optional copilot */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto bg-muted/30 p-8">
          <FlowCanvas
            graph={graph}
            agentName={(agentId) => agentsById.get(agentId) ?? ''}
            statusByNode={mode === 'test' ? statusByNode : {}}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onInsertAfter={(afterId, type) => {
              const { graph: next, nodeId } = insertNodeAfter(graph, afterId, type, type === 'agent' ? agents[0]?.id ?? '' : undefined)
              commitGraph(next)
              setSelectedId(nodeId)
            }}
            onAppendBranch={(conditionId, branch, type) => {
              const { graph: next, nodeId } = appendToBranch(graph, conditionId, branch, type, type === 'agent' ? agents[0]?.id ?? '' : undefined)
              commitGraph(next)
              setSelectedId(nodeId)
            }}
          />
        </div>

        {selectedNode && (
          <div className="w-80 shrink-0">
            <StepDrawer
              node={selectedNode}
              flowId={id}
              agents={agents}
              toolCatalog={toolCatalog}
              dataFields={dataFields}
              onChange={(node) => setGraph((g) => updateNode(g, node))}
              onChangeType={(type) => commitGraph(changeNodeType(graph, selectedNode.id, type))}
              onDuplicate={() => {
                const { graph: next, nodeId } = duplicateNode(graph, selectedNode.id)
                commitGraph(next)
                setSelectedId(nodeId)
              }}
              onAddStep={
                selectedNode.type === 'loop' || selectedNode.type === 'parallel'
                  ? () => {
                      const { graph: next, nodeId } = addContainerStep(graph, selectedNode.id)
                      commitGraph(next)
                      setSelectedId(nodeId)
                    }
                  : undefined
              }
              onDelete={() => {
                commitGraph(deleteNode(graph, selectedNode.id))
                setSelectedId(null)
              }}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}

        {showCopilot && (
          <div className="w-80 shrink-0">
            <CopilotPanel
              onGraph={(next) => {
                commitGraph(next as FlowGraph)
                setSelectedId(null)
                setShowCopilot(false)
              }}
            />
          </div>
        )}

        {showRuns && (
          <div className="w-80 shrink-0">
            <RunPanel
              runs={runs}
              selected={selectedRun}
              onSelectRun={selectRun}
              onClose={() => setShowRuns(false)}
              labelForNode={(nodeId) => {
                const node = graph.nodes.find((n) => n.id === nodeId)
                if (!node) return nodeId
                if (node.type === 'agent') return node.data.label || agentsById.get(node.data.agentId) || 'Agent step'
                return node.type.charAt(0).toUpperCase() + node.type.slice(1)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
