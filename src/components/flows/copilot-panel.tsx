'use client'

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Sparkles, Send, AlertTriangle, FlaskConical, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { streamCopilot } from '@/lib/client/copilot-stream'
import { cn, scrollBehavior } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { ScopedLink } from '@/components/ui/scoped-link'
import type { FlowGraph } from '@/lib/flows/graph'
import type { CopilotOp } from '@/lib/flows/copilot-ops'

type NeedsAttentionItem = { nodeId?: string; message: string }

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  resultLine?: string
  needsAttention?: NeedsAttentionItem[]
  error?: boolean
  /** Tool-activity labels streamed during this reply ("Reading flow run 4f2a…"). */
  activity?: string[]
  /** True while this reply is still streaming in. */
  streaming?: boolean
  /** Key into the demo-run state map when this reply launched a demo run. */
  demoId?: string
}

/** A copilot-launched demo run: sample-data seeded, polled to completion. */
type DemoStep = { nodeId: string; label: string; status: string; output: unknown; mocked: boolean }
type DemoRunState = {
  status: 'starting' | 'running' | 'succeeded' | 'failed'
  error?: string
  steps: DemoStep[]
  /** Connection ids the mocked steps point at — the "make it yours" list. */
  connectionsToSwap: string[]
}

const DEMO_POLL_MS = 1500
const DEMO_POLL_LIMIT = 60

const HISTORY_CAP = 20

export type CopilotRequest = { id: string; content: string; applyOps?: boolean }

export function CopilotPanel({
  graph,
  onGraph,
  onOps,
  onJump,
  onNeedsAttention,
  request,
  flowId,
}: {
  graph: FlowGraph
  onGraph: (graph: FlowGraph) => void
  onOps: (ops: CopilotOp[]) => { applied: number; skipped: { reason: string }[] }
  onJump: (nodeId: string) => void
  onNeedsAttention?: (issues: NeedsAttentionItem[]) => void
  request?: CopilotRequest | null
  /** The saved flow being edited — grounds the copilot's run-inspection tools. */
  flowId?: string
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [demoRuns, setDemoRuns] = useState<Record<string, DemoRunState>>({})
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const handledRequestRef = useRef<string | null>(null)
  // The graph prop (and the page's onOps closure over it) changes on every
  // edit; refs keep the async send handler reading the latest canvas instead
  // of the render it was created in — otherwise a mid-request manual edit
  // would be clobbered when the response ops apply against the old graph.
  const graphRef = useRef(graph)
  graphRef.current = graph
  const onOpsRef = useRef(onOps)
  onOpsRef.current = onOps

  const emptyCanvas = graph.nodes.length <= 1

  const labelForNode = useCallback((nodeId: string) => {
    const node = graphRef.current.nodes.find((entry) => entry.id === nodeId)
    return (node?.data as { label?: string } | undefined)?.label?.trim() || node?.type || nodeId
  }, [])

  /**
   * Execute a copilot-authored demo run: sample outputs seed the mocked steps
   * (no graph mutation, nothing sent for real), everything else runs live.
   * The run is polled here so its per-step outputs land in the chat thread —
   * the whole point is seeing the result without opening Slack/Gmail.
   */
  const executeDemoRun = useCallback(async (demoId: string, demo: { mockOutputs: Record<string, unknown>; input?: Record<string, unknown> }) => {
    if (!flowId) return
    const mockedIds = new Set(Object.keys(demo.mockOutputs))
    const connectionsToSwap = Array.from(new Set(graphRef.current.nodes.flatMap((node) => {
      if (!mockedIds.has(node.id)) return []
      const connectionId = (node.data as { connectionId?: string }).connectionId
      return connectionId ? [connectionId] : []
    })))
    const patch = (state: Partial<DemoRunState>) =>
      setDemoRuns((prev) => {
        const current: DemoRunState = prev[demoId] ?? { status: 'starting', steps: [], connectionsToSwap }
        return { ...prev, [demoId]: { ...current, ...state } }
      })
    patch({ status: 'starting' })
    try {
      const response = await fetch(`/api/flows/${flowId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: demo.input ?? {}, mockOutputs: demo.mockOutputs, demo: true }),
      })
      const body = await response.json().catch(() => ({}))
      const runId: string | undefined = body?.run?.flowRunId
      if (!response.ok || !runId) {
        patch({ status: 'failed', error: body.error || 'The demo run could not start.' })
        return
      }
      patch({ status: 'running' })
      for (let attempt = 0; attempt < DEMO_POLL_LIMIT; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, DEMO_POLL_MS))
        const poll = await fetch(`/api/flows/${flowId}/runs?take=10`).then((r) => r.json()).catch(() => null)
        const run = poll?.runs?.find((entry: { id: string }) => entry.id === runId)
        if (!run) continue
        if (run.status === 'queued' || run.status === 'claimed' || run.status === 'running') continue
        const steps: DemoStep[] = (run.steps ?? []).map((step: { nodeId: string; status: string; output?: unknown }) => ({
          nodeId: step.nodeId,
          label: labelForNode(step.nodeId),
          status: step.status,
          // Seeded steps persist as 'skipped' without output — show the sample.
          output: step.output ?? (mockedIds.has(step.nodeId) ? demo.mockOutputs[step.nodeId] : undefined),
          mocked: mockedIds.has(step.nodeId),
        }))
        patch({ status: run.status === 'succeeded' ? 'succeeded' : 'failed', error: run.error ?? undefined, steps })
        return
      }
      patch({ status: 'failed', error: 'The demo run is taking too long — check the Runs panel.' })
    } catch {
      patch({ status: 'failed', error: 'The demo run could not start — check your connection.' })
    }
  }, [flowId, labelForNode])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: scrollBehavior() })
  }, [messages, loading])

  const resizeInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [])

  // The one-shot generate path: drafts a whole flow from a description and
  // replaces the canvas. Kept as the empty-canvas quick action.
  const generate = async () => {
    const description = input.trim()
    if (!description || loading) return
    setLoading(true)
    try {
      const response = await fetch('/api/flows/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      const data = await response.json()
      if (response.ok && data.success && data.graph) {
        const steps = (data.graph.nodes || []).filter((n: { type: string }) => n.type !== 'trigger').length
        onGraph(data.graph)
        onNeedsAttention?.(data.needsAttention ?? [])
        setInput('')
        const errors = data.validation?.errors?.length ?? 0
        if (errors) {
          toast.warning(`Drafted ${steps} step${steps === 1 ? '' : 's'}, but ${errors} check${errors === 1 ? '' : 's'} need attention.`)
        } else {
          toast.success(steps ? `Drafted ${steps} step${steps === 1 ? '' : 's'} — review before running.` : 'No matching steps found for that description.')
        }
      } else {
        toast.error(data.error || 'Could not generate a flow.')
      }
    } finally {
      setLoading(false)
      requestAnimationFrame(resizeInput)
    }
  }

  const send = useCallback(async (requestedContent?: string, applyChanges = true) => {
    const content = (requestedContent ?? input).trim()
    if (!content || loading) return
    // Error bubbles stay in the thread for the user, but must not replay to
    // the model as genuine assistant turns.
    const history = [...messages.filter((message) => !message.error).map(({ role, content: text }) => ({ role, content: text })), { role: 'user' as const, content }].slice(-HISTORY_CAP)
    setMessages((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '', streaming: true, activity: [] }])
    setInput('')
    setLoading(true)
    // Mutates the trailing streaming placeholder bubble in place.
    const patchPending = (patch: (entry: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((entry, index) => (index === prev.length - 1 && entry.streaming ? patch(entry) : entry)))
    try {
      const outcome = await streamCopilot(
        '/api/flows/copilot/chat',
        { messages: history, graph: graphRef.current, ...(flowId ? { flowId } : {}) },
        {
          onText: (delta) => patchPending((entry) => ({ ...entry, content: entry.content + delta })),
          onTool: (activity) => patchPending((entry) => ({ ...entry, activity: [...(entry.activity ?? []), activity.label] })),
        },
      )
      const data = (outcome.ok ? outcome.result : {}) as Record<string, unknown> & {
        message?: string
        ops?: unknown
        needsAttention?: unknown
        demoRun?: { mockOutputs: Record<string, unknown>; input?: Record<string, unknown> }
      }
      if (outcome.ok) {
        // User-action remediations (credentials, permissions, URLs, missing
        // business values) are instruction-only. Discard any model-proposed
        // graph edits even if it ignored that boundary.
        const candidateOps = (data.ops ?? []) as CopilotOp[]
        const result = applyChanges
          ? onOpsRef.current(candidateOps)
          : { applied: 0, skipped: [] as { reason: string }[] }
        const parts: string[] = []
        if (result.applied > 0) parts.push(`Applied ${result.applied} change${result.applied === 1 ? '' : 's'}`)
        if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`)
        const needsAttention = (data.needsAttention ?? []) as NeedsAttentionItem[]
        const assistantContent = !applyChanges && candidateOps.length > 0
          ? `${data.message || 'Here is what you need to do.'}\n\nNo graph changes were applied because this fix requires your input.`
          : data.message || 'Done.'
        // A sanitized demo-run payload launches immediately: the run's step
        // outputs render under this reply as they land.
        const demoRun = data.demoRun && flowId ? data.demoRun : undefined
        const demoId = demoRun ? `demo-${Date.now().toString(36)}` : undefined
        // The result payload is authoritative: replace the streamed
        // approximation, keeping the activity labels it accumulated.
        patchPending((entry) => ({
          role: 'assistant',
          content: assistantContent,
          resultLine: parts.length ? parts.join(' · ') : undefined,
          needsAttention: needsAttention.length ? needsAttention : undefined,
          activity: entry.activity?.length ? entry.activity : undefined,
          demoId,
        }))
        onNeedsAttention?.(needsAttention)
        if (demoRun && demoId) void executeDemoRun(demoId, demoRun)
      } else if (!outcome.ok) {
        patchPending(() => ({ role: 'assistant', content: outcome.error || 'Could not apply that change — try again.', error: true }))
        // A dropped connection is a one-keystroke resend.
        setInput(content)
      }
    } catch {
      patchPending(() => ({ role: 'assistant', content: 'Could not reach the copilot — check your connection and try again.', error: true }))
    } finally {
      setLoading(false)
      requestAnimationFrame(resizeInput)
    }
  }, [input, loading, messages, onNeedsAttention, resizeInput, flowId, executeDemoRun])

  // Runtime Checker can hand a classified failed run directly to Copilot.
  // The request id makes the handoff exactly-once across graph/message renders.
  useEffect(() => {
    if (!request || loading || handledRequestRef.current === request.id) return
    handledRequestRef.current = request.id
    void send(request.content, request.applyOps !== false)
  }, [request, loading, send])

  // (DemoRunCard renders below the assistant bubble that launched the run.)
  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter during IME composition commits the candidate, not the message.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles className="h-4 w-4 text-indigo-500" />
        <h2 className="text-sm font-semibold">Copilot</h2>
      </div>

      <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {emptyCanvas
              ? 'Describe what the flow should do and I’ll draft runnable steps from your agents and connected tools.'
              : 'Ask for changes in plain language — add, edit, move, or remove steps — and I’ll apply them to the canvas.'}
          </p>
        )}
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{message.content}</div>
            </div>
          ) : (
            <div key={index} className="flex items-start gap-2">
              <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50">
                <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
              </span>
              <div className="min-w-0 max-w-[85%] space-y-1.5">
                <div
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm',
                    message.error ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-200' : 'border-border bg-background text-foreground',
                  )}
                >
                  {message.streaming && !message.content && !message.activity?.length
                    ? <span className="text-muted-foreground">Thinking…</span>
                    : message.streaming
                      ? <span className="whitespace-pre-wrap">{message.content}</span>
                      : <Markdown className="text-sm [&_p]:leading-6">{message.content}</Markdown>}
                </div>
                {message.demoId && demoRuns[message.demoId] && (
                  <DemoRunCard state={demoRuns[message.demoId]} onJump={onJump} />
                )}
                {message.streaming && message.activity && message.activity.length > 0 && (
                  <p className="px-1 text-[11px] text-muted-foreground">{message.activity[message.activity.length - 1]}</p>
                )}
                {!message.streaming && message.activity && message.activity.length > 0 && (
                  <details className="px-1 text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                      Investigated {message.activity.length} thing{message.activity.length === 1 ? '' : 's'}
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {message.activity.map((label, labelIndex) => <li key={labelIndex}>{label}</li>)}
                    </ul>
                  </details>
                )}
                {message.resultLine && <p className="px-1 text-[11px] font-medium text-muted-foreground">{message.resultLine}</p>}
                {message.needsAttention?.map((issue, issueIndex) =>
                  issue.nodeId ? (
                    <button
                      key={issueIndex}
                      type="button"
                      onClick={() => onJump(issue.nodeId!)}
                      className="flex w-full items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-left text-[11px] text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
                    >
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                      {issue.message}
                    </button>
                  ) : (
                    <p key={issueIndex} className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                      {issue.message}
                    </p>
                  ),
                )}
              </div>
            </div>
          ),
        )}
        {/* Chat turns carry their thinking state in the streaming placeholder
            bubble; this row only covers the one-shot Generate path. */}
        {loading && !messages.some((message) => message.streaming) && (
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50">
              <Sparkles className="h-3.5 w-3.5 animate-pulse text-indigo-500" />
            </span>
            <p className="text-xs text-muted-foreground">Thinking…</p>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-border p-3">
        {emptyCanvas && (
          <Button variant="outline" size="sm" className="w-full" onClick={generate} disabled={loading || !input.trim()}>
            <Sparkles className="mr-1.5 h-4 w-4 text-indigo-500" /> Generate a flow
          </Button>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              resizeInput()
            }}
            onKeyDown={onInputKeyDown}
            placeholder={emptyCanvas ? 'e.g. Score my in-segment accounts and post the top 20 to #sales.' : 'Ask for a change…'}
            className="max-h-[140px] min-h-[38px] w-full flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300"
            aria-label="Message the copilot"
          />
          <Button size="icon" onClick={() => void send()} loading={loading} disabled={!input.trim()} aria-label="Send message">
            {!loading && <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {emptyCanvas ? 'AI-generated — Generate replaces the canvas. Review before running.' : 'AI edits apply directly to the canvas — ⌘Z to undo.'}
        </p>
      </div>
    </div>
  )
}

/** Clip a step output for inline display without dumping megabytes into the DOM. */
function demoOutputText(output: unknown): string {
  if (output === undefined || output === null) return ''
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
  return text.length > 1_200 ? `${text.slice(0, 1_200)}… [truncated]` : text
}

/**
 * A demo run's live results, inline in the chat thread: per-step outputs
 * (sample-data steps badged), then the exact connections to swap in to make
 * the flow real. This is the "see the Slack message without opening Slack"
 * surface.
 */
function DemoRunCard({ state, onJump }: { state: DemoRunState; onJump: (nodeId: string) => void }) {
  const running = state.status === 'starting' || state.status === 'running'
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-2 text-xs dark:border-indigo-900/50 dark:bg-indigo-950/30">
      <p className="flex items-center gap-1.5 font-medium text-indigo-800 dark:text-indigo-200">
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
        Demo run — sample data, nothing was sent for real
      </p>
      {running && <p className="mt-1 text-muted-foreground">Running the flow end-to-end…</p>}
      {state.status === 'failed' && (
        <p className="mt-1 flex items-start gap-1 text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" /> {state.error || 'The demo run failed.'}
        </p>
      )}
      {state.steps.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {state.steps.map((step) => (
            <li key={step.nodeId} className="rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => onJump(step.nodeId)} className="truncate font-medium hover:underline">
                  {step.label}
                </button>
                {step.mocked && (
                  <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-px text-[10px] text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300">
                    sample data
                  </span>
                )}
                <span
                  className={cn(
                    'ml-auto shrink-0 text-[10px]',
                    step.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
                  )}
                >
                  {step.status === 'skipped' && step.mocked ? 'mocked' : step.status}
                </span>
              </div>
              {demoOutputText(step.output) && (
                <details className="mt-1">
                  <summary className="cursor-pointer select-none text-[11px] text-muted-foreground">Output</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-1.5 text-[11px]">{demoOutputText(step.output)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {!running && state.connectionsToSwap.length > 0 && (
        <p className="mt-2 text-muted-foreground">
          To make this real, connect{' '}
          <span className="font-medium text-foreground">{state.connectionsToSwap.join(', ')}</span> in{' '}
          <ScopedLink href="/integrations" className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">
            Integrations
          </ScopedLink>
          , then re-select the connection on the badged steps.
        </p>
      )}
    </div>
  )
}
