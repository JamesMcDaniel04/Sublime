'use client'

import { useEffect, useRef, useState } from 'react'
import { Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FlowNode } from '@/lib/flows/graph'
import type { NodeRef } from '@/lib/flows/node-test-input'
import type { DataField } from '@/lib/flows/datatree'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import type { ToolCatalog } from '../tool-catalog-type'
import type { EditableType } from '../node-types'
import type { TokenTextEditorHandle } from '../token-text-editor'
import { ResizablePanel } from '../resizable-panel'
import { NODE_BODIES } from '../nodes/registry'
import type { Agent, TokenEditorWiring } from '../nodes/types'
import { ParamsPane } from './params-pane'
import { InputPane } from './input-pane'
import { OutputPane } from './output-pane'

const NON_TOKEN_FOCUSED = 'non-token-focused'
const EMPTY_LABEL_CTX: TokenLabelContext = { stepLabels: {} }

/**
 * The Node Detail View: the single node-config surface. Input (upstream data)
 * | Parameters (the registry body) | Output (last run / pinned data), n8n's
 * NDV shape. The canvas card is a summary that opens this.
 *
 * The input pane replaces the card's floating token popover — there is a
 * permanent place to click/drag tokens from, so no popover positioning here.
 */
const CONTAINER_TYPES = new Set(['loop', 'parallel', 'repeatUntil', 'errorShield'])
const CONTAINER_REASON = 'This step contains other steps — test the steps inside it individually.'

export type NodeTestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'succeeded' }
  | { status: 'failed'; error: string }

export function NodeDetailView({
  node,
  flowId,
  agents,
  toolCatalog,
  dataFields,
  labelCtx,
  variableNames,
  lastOutput,
  pinned = false,
  onPin,
  onUnpin,
  onTestStep,
  onRunFromHere,
  testState,
  riskyMissing = [],
  downstreamWrites = [],
  onChange,
  onChangeType,
  onRefreshAgents,
  onAddStep,
  onClose,
}: {
  node: FlowNode
  flowId?: string
  agents: Agent[]
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  labelCtx?: TokenLabelContext
  variableNames?: string[]
  lastOutput: unknown
  pinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
  /** Run exactly this node (ancestor data already resolved by the caller). */
  onTestStep?: () => void
  /** Run this node AND everything after it (today's startNodeId behaviour). */
  onRunFromHere?: () => void
  testState?: NodeTestState
  /** Missing ancestors that perform writes — named in a confirm before any run. */
  riskyMissing?: NodeRef[]
  /** Downstream write actions a Run-from-here would fire. */
  downstreamWrites?: NodeRef[]
  onChange: (node: FlowNode) => void
  onChangeType?: (type: EditableType) => void
  onRefreshAgents?: () => void
  onAddStep?: (type: EditableType, branchIndex?: number) => void
  onClose: () => void
}) {
  // Which action is awaiting an explicit go-ahead. Confirms exist only where
  // there is a real side effect to name; a reflexive confirm teaches users to
  // click through warnings.
  const [confirming, setConfirming] = useState<'test' | 'runFromHere' | null>(null)
  const isContainer = CONTAINER_TYPES.has(node.type)
  const testStep = () => {
    if (riskyMissing.length > 0) setConfirming('test')
    else onTestStep?.()
  }
  const runFromHere = () => {
    if (downstreamWrites.length > 0) setConfirming('runFromHere')
    else onRunFromHere?.()
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Token wiring, same shape as the card's: chip-editor handles keyed by
  // field, so an input-pane click inserts at the caret of the last-focused
  // editor, falling back to the node type's primary field.
  const editorHandles = useRef<Map<string, TokenTextEditorHandle | null>>(new Map())
  const editorRefCallbacks = useRef<Map<string, (handle: TokenTextEditorHandle | null) => void>>(new Map())
  const activeFieldRef = useRef<string | null>(null)
  const registerEditor = (key: string) => {
    let callback = editorRefCallbacks.current.get(key)
    if (!callback) {
      callback = (handle: TokenTextEditorHandle | null) => {
        editorHandles.current.set(key, handle)
      }
      editorRefCallbacks.current.set(key, callback)
    }
    return callback
  }
  const focusEditor = (key: string) => () => {
    activeFieldRef.current = key
  }
  const blockActive = () => {
    activeFieldRef.current = NON_TOKEN_FOCUSED
  }
  const unblockActive = () => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) activeFieldRef.current = null
  }
  const insertToken = (token: string) => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) return
    const path = token.startsWith('{{') && token.endsWith('}}') ? token.slice(2, -2).trim() : token
    const active = activeFieldRef.current ? editorHandles.current.get(activeFieldRef.current) : null
    const fallbackKey = NODE_BODIES[node.type].defaultEditorKey
    const editor = active ?? (fallbackKey ? editorHandles.current.get(fallbackKey) : null)
    editor?.insertToken(path)
  }
  const tokenWiring: TokenEditorWiring = {
    labelCtx: labelCtx ?? EMPTY_LABEL_CTX,
    registerEditor,
    focusEditor,
    blockActive,
    unblockActive,
  }

  const label = ('label' in node.data && node.data.label) || node.type

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/40 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={`Configure ${label}`}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</h2>
          {onTestStep && node.type !== 'trigger' && (
            <span title={isContainer ? CONTAINER_REASON : undefined}>
              <Button size="sm" onClick={testStep} disabled={isContainer || testState?.status === 'running'} loading={testState?.status === 'running'}>
                <Play className="mr-1.5 h-3.5 w-3.5" /> Test step
              </Button>
            </span>
          )}
          {onRunFromHere && node.type !== 'trigger' && !isContainer && (
            <Button size="sm" variant="outline" onClick={runFromHere} disabled={testState?.status === 'running'}>
              Run from here
            </Button>
          )}
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {confirming === 'test' && (
          <div className="border-b border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900/40 dark:bg-amber-950/30">
            <p className="font-semibold text-amber-900 dark:text-amber-200">These earlier steps have no data yet and make real changes:</p>
            <ul className="mt-1.5 list-disc pl-5 text-amber-900 dark:text-amber-200">
              {riskyMissing.map((ref) => (
                <li key={ref.id}>{ref.label} <span className="font-mono text-[10px] uppercase">{ref.risk}</span></li>
              ))}
            </ul>
            <p className="mt-2 text-amber-800 dark:text-amber-300">Running them will make those changes for real. Pin their output instead to avoid it.</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => { setConfirming(null); onTestStep?.() }}>Run them anyway</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
            </div>
          </div>
        )}
        {confirming === 'runFromHere' && (
          <div className="border-b border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900/40 dark:bg-amber-950/30">
            <p className="font-semibold text-amber-900 dark:text-amber-200">Running from here also fires these later actions:</p>
            <ul className="mt-1.5 list-disc pl-5 text-amber-900 dark:text-amber-200">
              {downstreamWrites.map((ref) => (
                <li key={ref.id}>{ref.label} <span className="font-mono text-[10px] uppercase">{ref.risk}</span></li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => { setConfirming(null); onRunFromHere?.() }}>Run anyway</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {/* ResizablePanel is right-docked (dragging left widens), so it fits
              only the output side; the input pane takes a plain fixed width. */}
          <div className="w-[280px] shrink-0">
            <InputPane dataFields={dataFields} onInsertToken={insertToken} />
          </div>
          <div className="min-w-0 flex-1 border-x border-border">
            <ParamsPane
              node={node}
              flowId={flowId}
              agents={agents}
              toolCatalog={toolCatalog}
              update={onChange}
              onRefreshAgents={onRefreshAgents}
              tokenWiring={tokenWiring}
              variableNames={variableNames}
              dataFields={dataFields}
              onAddStep={onAddStep}
              onChangeType={onChangeType}
            />
          </div>
          <ResizablePanel storageKey="flow.ndv.outputWidth" defaultWidth={320}>
            <OutputPane lastOutput={lastOutput} pinned={pinned} onPin={onPin} onUnpin={onUnpin} error={testState?.status === 'failed' ? testState.error : undefined} />
          </ResizablePanel>
        </div>
      </div>
    </div>
  )
}
