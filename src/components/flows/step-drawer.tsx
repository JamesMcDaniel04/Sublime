'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Trash2, Plus, Copy, Link2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CONDITION_OPS, CONDITION_OP_LABELS, DATA_OPS, FIELD_TYPES, VARIABLE_OPS, VARIABLE_OP_LABELS, VARIABLE_TYPES, VARIABLE_TYPE_LABELS, type FlowNode, type ConditionOp, type ConditionClause, type DataOp, type OutputField, type TriggerInputField, type VariableOp, type VariableType } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { DATA_OP_HELPER, DATA_OP_INPUT_PLACEHOLDER, VARIABLE_VALUE_PLACEHOLDER, variableValueOptional } from '@/lib/flows/step-copy'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { KNOWN_SIGNALS } from '@/lib/flows/trigger'
import { nextOccurrence, type AgentSchedule } from '@/lib/scheduling/due'
import { DataTree } from '@/components/flows/data-tree'
import { ToolArgsEditor } from '@/components/flows/tool-args-editor'
import type { DataField } from '@/lib/flows/datatree'
import { AdvancedParamsSection } from '@/components/flows/advanced-params'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import { cn } from '@/lib/utils'

type EditableType = Extract<FlowNode['type'], 'agent' | 'condition' | 'loop' | 'parallel' | 'stop' | 'tool' | 'http' | 'transform' | 'filter' | 'switch' | 'variable' | 'data' | 'humanReview'>
const NODE_TYPES: { value: EditableType; label: string }[] = [
  { value: 'agent', label: 'Run agent' },
  { value: 'tool', label: 'Tool call' },
  { value: 'http', label: 'HTTP request' },
  { value: 'transform', label: 'Set fields' },
  { value: 'data', label: 'Data operation' },
  { value: 'variable', label: 'Variable' },
  { value: 'humanReview', label: 'Request information' },
  { value: 'condition', label: 'If / else' },
  { value: 'switch', label: 'Switch' },
  { value: 'filter', label: 'Filter' },
  { value: 'loop', label: 'For each' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'stop', label: 'Stop' },
]

export type ToolCatalog = { id: string; name: string; tools: { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown }[]; toolsError?: string }[]

/** Frequencies the schedule editor offers (matches AgentSchedule types). */
const FREQUENCIES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Cron expression' },
  { value: 'once', label: 'Once' },
] as const

type TriggerData = {
  type?: 'manual' | 'schedule' | 'webhook' | 'signal'
  schedule?: { type?: string; time?: string; cron?: string; timezone?: string; runAt?: string; isActive?: boolean }
  input?: string
  inputFields?: TriggerInputField[]
  signal?: string
  /** "Only run when…": the run is skipped unless these clauses match the trigger payload. */
  filter?: { match?: 'all' | 'any'; clauses?: ConditionClause[] }
}

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
// Textareas: comfortable default height, user-resizable vertically.
const areaClass = `${fieldClass} min-h-[120px] resize-y`
const smallField =
  'rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function clausesOf(data: { clauses?: ConditionClause[]; left?: string; op?: ConditionOp; right?: string }): ConditionClause[] {
  if (data.clauses && data.clauses.length) return data.clauses
  if (data.left !== undefined || data.right !== undefined)
    return [{ left: data.left ?? '', op: data.op ?? 'contains', right: data.right ?? '' }]
  return [{ left: '', op: 'contains', right: '' }]
}

type KeyValueRow = { key: string; value: string }

function parseKeyValueRows(value: string | undefined): { rows: KeyValueRow[]; invalid: boolean } {
  if (!value?.trim()) return { rows: [{ key: '', value: '' }], invalid: false }
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { rows: [{ key: '', value }], invalid: true }
    const rows = Object.entries(parsed).map(([key, item]) => ({
      key,
      value: typeof item === 'string' ? item : JSON.stringify(item),
    }))
    return { rows: rows.length ? rows : [{ key: '', value: '' }], invalid: false }
  } catch {
    return { rows: [{ key: '', value }], invalid: true }
  }
}

function parseTypedValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!/^(?:true|false|null|-?\d|\{|\[|")/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function serializeKeyValueRows(rows: KeyValueRow[]): string | undefined {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = parseTypedValue(row.value)
  }
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : undefined
}

function KeyValueJsonEditor({
  label,
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  helper,
  labelCtx,
  editorKey,
  registerEditor,
  focusEditor,
  blockActive,
  unblockActive,
}: {
  label: string
  value: string | undefined
  onChange: (value: string | undefined) => void
  keyPlaceholder: string
  valuePlaceholder: string
  helper: string
  labelCtx: TokenLabelContext
  editorKey: string
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  blockActive: () => void
  unblockActive: () => void
}) {
  const parsed = parseKeyValueRows(value)

  if (parsed.invalid) {
    return (
      <div>
        <label className={labelClass}>{label}</label>
        <textarea
          rows={3}
          className={`${areaClass} font-mono text-xs`}
          value={value ?? ''}
          placeholder={'{"name": "value"}'}
          onFocus={blockActive}
          onBlur={unblockActive}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        <p className="mt-1 text-[11px] text-amber-600">This saved value is not a JSON object. Fix it here, or clear it to return to key/value rows.</p>
      </div>
    )
  }

  const savedRows = parsed.rows.filter((row) => row.key || row.value)
  const displayRows = [...savedRows, { key: '', value: '' }]
  const setRow = (index: number, patch: Partial<KeyValueRow>) => {
    const next = [...savedRows]
    const current = next[index] ?? { key: '', value: '' }
    next[index] = {
      key: patch.key ?? current.key,
      value: patch.value ?? current.value,
    }
    onChange(serializeKeyValueRows(next))
  }
  const removeRow = (index: number) => {
    onChange(serializeKeyValueRows(savedRows.filter((_row, rowIndex) => rowIndex !== index)))
  }

  return (
    <div>
      <label className={labelClass}>{label}</label>
      <div className="space-y-2 rounded-xl border border-border bg-background/40 p-2">
        {displayRows.map((row, index) => {
          const saved = index < savedRows.length
          return (
            <div key={index} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto] gap-2">
              <input
                className={smallField}
                value={row.key}
                placeholder={keyPlaceholder}
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => setRow(index, { key: e.target.value })}
              />
              <TokenTextEditor
                ref={registerEditor(`${editorKey}.${index}.value`)}
                className="min-w-0 px-2 py-1.5"
                value={row.value}
                placeholder={valuePlaceholder}
                labelCtx={labelCtx}
                onFocus={focusEditor(`${editorKey}.${index}.value`)}
                onChange={(next) => setRow(index, { value: next })}
                ariaLabel={`${label} value`}
              />
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} row`}
                disabled={!saved}
                onClick={() => removeRow(index)}
                className="rounded-lg border border-border px-2 text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{helper}</p>
    </div>
  )
}

function AddNestedStepMenu({
  label,
  onPick,
}: {
  label: string
  onPick: (type: EditableType) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen((value) => !value)}>
        <Plus className="mr-1.5 h-4 w-4" /> {label}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-border bg-card p-1 shadow-popover">
            {NODE_TYPES.map((type) => (
              <button
                key={type.value}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onPick(type.value)
                }}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                {type.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Sentinel for activeFieldRef: a non-token input (raw-JSON textarea, KV key
// names, label/notes, field-name inputs, …) is focused, so datatree inserts
// must be a no-op — falling back to the step's primary field would silently
// write to a field the user is not editing.
const NON_TOKEN_FOCUSED = 'non-token-focused'

// Where a datatree click lands when no chip editor has been focused yet: the
// step type's primary token field (mirrors the old default-accessor behavior).
const DEFAULT_EDITOR_KEYS: Partial<Record<FlowNode['type'], string>> = {
  agent: 'agent.input',
  loop: 'loop.over',
  http: 'http.body',
  transform: 'xf.0',
  condition: 'cond.0.left',
  filter: 'filt.0.left',
  switch: 'sw.0.left',
  variable: 'var.value',
  data: 'data.input',
  humanReview: 'hr.message',
}

export function StepDrawer({
  node,
  flowId,
  agents,
  toolCatalog,
  dataFields,
  labelCtx,
  variableNames,
  issues,
  onChange,
  onChangeType,
  onAddStep,
  onDuplicate,
  onDelete,
  onClose,
}: {
  node: FlowNode
  flowId: string
  agents: { id: string; title: string }[]
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  variableNames?: string[]
  issues?: { level: 'error' | 'warning'; message: string }[]
  onChange: (node: FlowNode) => void
  onChangeType: (type: EditableType) => void
  onAddStep?: (type: EditableType) => void
  onDuplicate?: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const isTrigger = node.type === 'trigger'
  // Chip-editor handles keyed by field, so a datatree click inserts a token
  // chip at the caret of the last-focused editor. Keys are looked up live at
  // insert time — an unmounted editor's map slot is null, so inserts fall back
  // to the step's default field instead of vanishing.
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
  // While any non-token input is focused, datatree inserts are blocked
  // entirely; blur restores the normal fallback behavior.
  const blockActive = () => {
    activeFieldRef.current = NON_TOKEN_FOCUSED
  }
  const unblockActive = () => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) activeFieldRef.current = null
  }
  useEffect(() => {
    activeFieldRef.current = null
  }, [node.id])

  const setLabel = (label: string) => onChange({ ...node, data: { ...node.data, label } } as FlowNode)

  // Insert a token chip at the caret of the last-focused editor; fall back to
  // the step's primary field when nothing has been focused yet. DataTree emits
  // braced `{{token}}`s; the chip editor takes the bare path.
  const insertToken = (token: string) => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) return
    const path = token.startsWith('{{') && token.endsWith('}}') ? token.slice(2, -2).trim() : token
    const active = activeFieldRef.current ? editorHandles.current.get(activeFieldRef.current) : null
    const fallbackKey = DEFAULT_EDITOR_KEYS[node.type]
    const editor = active ?? (fallbackKey ? editorHandles.current.get(fallbackKey) : null)
    editor?.insertToken(path)
  }

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{isTrigger ? 'Trigger' : 'Configure step'}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-5 p-4">
        {issues && issues.length > 0 && (
          <div
            className={cn(
              'rounded-md border p-3 text-sm',
              issues.some((issue) => issue.level === 'error') ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50',
            )}
          >
            <p className="font-semibold text-slate-900">This step needs attention</p>
            <ul className="mt-2 space-y-1.5">
              {[...issues]
                .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
                .map((issue, issueIndex) => (
                  <li key={issueIndex} className="flex items-start gap-2 text-slate-700">
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', issue.level === 'error' ? 'bg-red-500' : 'bg-amber-500')} />
                    <span className="min-w-0">{issue.message}</span>
                  </li>
                ))}
            </ul>
          </div>
        )}
        {isTrigger ? (
          <TriggerEditor
            flowId={flowId}
            trigger={(node.data.trigger as TriggerData | undefined) ?? { type: 'manual' }}
            onChange={(trigger) => onChange({ ...node, data: { trigger } })}
          />
        ) : (
          <>
            <div>
              <label className={labelClass}>Step type</label>
              <select className={fieldClass} value={node.type} onChange={(e) => onChangeType(e.target.value as EditableType)}>
                {NODE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Label (optional)</label>
              <input className={fieldClass} value={(node.data as { label?: string }).label ?? ''} placeholder="A short name for this step" onFocus={blockActive} onBlur={unblockActive} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Notes (optional)</label>
              <textarea
                rows={2}
                className={fieldClass}
                value={(node.data as { note?: string }).note ?? ''}
                placeholder="Why this step exists, gotchas, links…"
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => onChange({ ...node, data: { ...node.data, note: e.target.value || undefined } } as FlowNode)}
              />
            </div>
          </>
        )}

        {node.type === 'agent' && (
          <>
            <div>
              <label className={labelClass}>Agent</label>
              <select className={fieldClass} value={node.data.agentId} onChange={(e) => onChange({ ...node, data: { ...node.data, agentId: e.target.value } })}>
                <option value="">Select an agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.title}
                  </option>
                ))}
              </select>
              {agents.length === 0 && <p className="mt-1.5 text-xs text-amber-600">No agents yet — create one first.</p>}
            </div>
            <div>
              <label className={labelClass}>Message to agent</label>
              <TokenTextEditor
                ref={registerEditor('agent.input')}
                multiline
                rows={6}
                value={node.data.input ?? ''}
                labelCtx={labelCtx}
                placeholder="Tell the agent what to do. Add flow data from the picker below when needed."
                onFocus={focusEditor('agent.input')}
                onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
                ariaLabel="Message to agent"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <AdvancedParamsSection node={node} onChange={onChange} defaultOpen />
            <div>
              <label className={labelClass}>Human assistance</label>
              <select
                className={fieldClass}
                value={node.data.humanAssistance === false ? 'off' : 'on'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, humanAssistance: e.target.value === 'off' ? false : undefined } })}
              >
                <option value="on">Pause and ask when unsure</option>
                <option value="off">Never ask — fail instead</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Agent response</label>
              <select
                className={fieldClass}
                value={node.data.responseFormat ?? 'text'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, responseFormat: e.target.value === 'structured' ? 'structured' : undefined } })}
              >
                <option value="text">Text only</option>
                <option value="structured">Structured (JSON matching output fields)</option>
              </select>
              {node.data.responseFormat === 'structured' && !(node.data.outputFields ?? []).some((f) => f.name.trim()) && (
                <p className="mt-1.5 text-xs text-amber-600">Add at least one output field below to define the JSON shape.</p>
              )}
            </div>
            <OutputFieldsEditor
              fields={node.data.outputFields ?? []}
              onChange={(outputFields) => onChange({ ...node, data: { ...node.data, outputFields: outputFields.length ? outputFields : undefined } })}
              blockActive={blockActive}
              unblockActive={unblockActive}
            />
          </>
        )}

        {node.type === 'condition' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Match</label>
              <select
                className={fieldClass}
                value={node.data.match ?? 'all'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value as 'all' | 'any', clauses: clausesOf(node.data), left: undefined, op: undefined, right: undefined } })}
              >
                <option value="all">All conditions (AND)</option>
                <option value="any">Any condition (OR)</option>
              </select>
            </div>
            {clausesOf(node.data).map((clause, i) => {
              const clauses = clausesOf(node.data)
              const update = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next, left: undefined, op: undefined, right: undefined } })
              return (
                <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                  <TokenTextEditor
                    ref={registerEditor(`cond.${i}.left`)}
                    className="px-2 py-1.5"
                    value={clause.left}
                    labelCtx={labelCtx}
                    placeholder="Choose data from below"
                    onFocus={focusEditor(`cond.${i}.left`)}
                    onChange={(left) => update(clauses.map((c, j) => (j === i ? { ...c, left } : c)))}
                    ariaLabel={`Condition ${i + 1} value`}
                  />
                  <div className="flex gap-1.5">
                    <select className={smallField} value={clause.op} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                      {CONDITION_OPS.map((op) => (
                        <option key={op} value={op}>
                          {CONDITION_OP_LABELS[op]}
                        </option>
                      ))}
                    </select>
                    <TokenTextEditor
                      ref={registerEditor(`cond.${i}.right`)}
                      className="min-w-0 flex-1 px-2 py-1.5"
                      value={clause.right}
                      labelCtx={labelCtx}
                      placeholder="80"
                      onFocus={focusEditor(`cond.${i}.right`)}
                      onChange={(right) => update(clauses.map((c, j) => (j === i ? { ...c, right } : c)))}
                      ariaLabel={`Condition ${i + 1} comparison value`}
                    />
                    {clauses.length > 1 && (
                      <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove condition">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            <button
              type="button"
              onClick={() => onChange({ ...node, data: { ...node.data, clauses: [...clausesOf(node.data), { left: '', op: 'contains', right: '' }], left: undefined, op: undefined, right: undefined } })}
              className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add condition
            </button>
            <div>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
          </div>
        )}

        {node.type === 'loop' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Items to process</label>
              <TokenTextEditor
                ref={registerEditor('loop.over')}
                value={node.data.over}
                labelCtx={labelCtx}
                placeholder="Choose a list from the available data below"
                onFocus={focusEditor('loop.over')}
                onChange={(over) => onChange({ ...node, data: { ...node.data, over } })}
                ariaLabel="Items to process"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">Accepts a JSON list, a newline list, or a comma-separated list. Nested steps run once for each item.</p>
            </div>
            <div>
              <label className={labelClass}>At a time</label>
              <input
                type="number"
                min={1}
                max={20}
                className={fieldClass}
                value={node.data.concurrency ?? 3}
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => onChange({ ...node, data: { ...node.data, concurrency: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } })}
              />
            </div>
            {onAddStep && (
              <AddNestedStepMenu label="Add step to loop" onPick={onAddStep} />
            )}
          </div>
        )}

        {node.type === 'parallel' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Runs {node.data.branches.length} branch{node.data.branches.length === 1 ? '' : 'es'} at once and merges their outputs. Click an indented card to edit a branch step.
            </p>
            {onAddStep && (
              <AddNestedStepMenu label="Add parallel branch" onPick={onAddStep} />
            )}
          </div>
        )}

        {node.type === 'tool' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Connection</label>
              <select
                className={fieldClass}
                value={node.data.connectionId}
                onChange={(e) => onChange({ ...node, data: { ...node.data, connectionId: e.target.value, toolName: '' } })}
              >
                <option value="">Select a connection…</option>
                {toolCatalog.map((conn) => (
                  <option key={conn.id} value={conn.id}>
                    {conn.name}
                  </option>
                ))}
              </select>
              {toolCatalog.length === 0 && (
                <p className="mt-1.5 text-xs text-amber-600">No MCP connections yet — add one on the MCP Servers page.</p>
              )}
            </div>
            <div>
              <label className={labelClass}>Tool</label>
              <select
                className={fieldClass}
                value={node.data.toolName}
                onChange={(e) => onChange({ ...node, data: { ...node.data, toolName: e.target.value } })}
              >
                <option value="">Select a tool…</option>
                {(toolCatalog.find((c) => c.id === node.data.connectionId)?.tools ?? []).map((tool) => (
                  <option key={tool.name} value={tool.name} title={tool.description}>
                    {tool.name}
                  </option>
                ))}
              </select>
            </div>
            {node.data.toolName ? (
              <ToolArgsEditor
                inputSchema={toolCatalog.find((c) => c.id === node.data.connectionId)?.tools.find((t) => t.name === node.data.toolName)?.inputSchema}
                args={node.data.args}
                onChange={(nextArgs) => onChange({ ...node, data: { ...node.data, args: nextArgs } })}
                dataFields={dataFields}
                labelCtx={labelCtx}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Pick a tool to configure its inputs.</p>
            )}
            <AdvancedParamsSection node={node} onChange={onChange} defaultOpen />
            <p className="text-xs text-muted-foreground">Runs this exact tool with these arguments — deterministic, retryable, and no agent in the loop.</p>
          </div>
        )}

        {node.type === 'http' && (
          <div className="space-y-3">
            <div className="flex gap-1.5">
              <select
                className={smallField}
                value={node.data.method}
                onChange={(e) => onChange({ ...node, data: { ...node.data, method: e.target.value as typeof node.data.method } })}
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <TokenTextEditor
                ref={registerEditor('http.url')}
                className="min-w-0 flex-1 px-2 py-1.5"
                value={node.data.url}
                labelCtx={labelCtx}
                placeholder="https://example.com/webhook"
                onFocus={focusEditor('http.url')}
                onChange={(url) => onChange({ ...node, data: { ...node.data, url } })}
                ariaLabel="Request URL"
              />
            </div>
            <KeyValueJsonEditor
              label="Query params"
              value={node.data.query}
              keyPlaceholder="account_id"
              valuePlaceholder="Click a value from Available data"
              helper="Added to the URL after ?. Arrays send repeated params; booleans and numbers are preserved."
              onChange={(query) => onChange({ ...node, data: { ...node.data, query } })}
              labelCtx={labelCtx}
              editorKey="http.query"
              registerEditor={registerEditor}
              focusEditor={focusEditor}
              blockActive={blockActive}
              unblockActive={unblockActive}
            />
            <KeyValueJsonEditor
              label="Headers"
              value={node.data.headers}
              keyPlaceholder="authorization"
              valuePlaceholder="Bearer token"
              helper="Sent as request headers. Do not place secrets here unless this flow is allowed to use them."
              onChange={(headers) => onChange({ ...node, data: { ...node.data, headers } })}
              labelCtx={labelCtx}
              editorKey="http.headers"
              registerEditor={registerEditor}
              focusEditor={focusEditor}
              blockActive={blockActive}
              unblockActive={unblockActive}
            />
            <div>
              <label className={labelClass}>Authenticate with (optional)</label>
              <select
                className={fieldClass}
                value={node.data.connectionId ?? ''}
                onChange={(e) => onChange({ ...node, data: { ...node.data, connectionId: e.target.value || undefined } })}
              >
                <option value="">No authentication</option>
                {toolCatalog.filter((conn) => parseFlowToolConnectionId(conn.id).plane === 'mcp').map((conn) => (
                  <option key={conn.id} value={conn.id}>
                    {conn.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Uses this connection&apos;s login to authorize the request — connections shared with your workspace, plus your own. Your own Authorization header always takes precedence.
              </p>
            </div>
            <div>
              <label className={labelClass}>Body</label>
              {(node.data.bodyMode ?? 'json') === 'none' ? (
                <textarea rows={4} className={`${areaClass} font-mono text-xs`} value={node.data.body ?? ''} disabled />
              ) : (
                <TokenTextEditor
                  ref={registerEditor('http.body')}
                  multiline
                  rows={4}
                  className="font-mono text-xs"
                  value={node.data.body ?? ''}
                  labelCtx={labelCtx}
                  placeholder={(node.data.bodyMode ?? 'json') === 'text' ? 'Plain text body' : '{"text": "Use a value from Available data"}'}
                  onFocus={focusEditor('http.body')}
                  onChange={(body) => onChange({ ...node, data: { ...node.data, body: body || undefined } })}
                  ariaLabel="Request body"
                />
              )}
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass}>Cookie</label>
              <TokenTextEditor
                ref={registerEditor('http.cookie')}
                className="min-w-0 flex-1 px-2 py-1.5"
                value={node.data.cookie ?? ''}
                labelCtx={labelCtx}
                placeholder="name=value; other=value"
                onFocus={focusEditor('http.cookie')}
                onChange={(cookie) => onChange({ ...node, data: { ...node.data, cookie: cookie || undefined } })}
                ariaLabel="Cookie"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">Sent as the request&apos;s Cookie header. An explicit Cookie among Headers takes precedence.</p>
            </div>
            <AdvancedParamsSection node={node} onChange={onChange} defaultOpen />
            <p className="text-xs text-muted-foreground">Calls a public HTTPS URL. Output includes status, headers, parsed body, and raw bodyText. Retries re-send the request.</p>
          </div>
        )}

        {node.type === 'transform' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Create named fields for later steps to use.</p>
            {node.data.fields.map((field, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                <div className="flex gap-1.5">
                  <input
                    className={`${smallField} flex-1`}
                    value={field.name}
                    placeholder="fieldName"
                    onFocus={blockActive}
                    onBlur={unblockActive}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, fields: node.data.fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)) } })}
                  />
                  <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, fields: node.data.fields.filter((_, j) => j !== i) } })} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove field">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <TokenTextEditor
                  ref={registerEditor(`xf.${i}`)}
                  className="px-2 py-1.5"
                  value={field.value}
                  labelCtx={labelCtx}
                  placeholder="Value for this field"
                  onFocus={focusEditor(`xf.${i}`)}
                  onChange={(value) => onChange({ ...node, data: { ...node.data, fields: node.data.fields.map((f, j) => (j === i ? { ...f, value } : f)) } })}
                  ariaLabel={`Value for field ${field.name || i + 1}`}
                />
              </div>
            ))}
            <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, fields: [...node.data.fields, { name: '', value: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add field
            </button>
            <div>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
          </div>
        )}

        {node.type === 'filter' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Continue only when this passes. Inside a For-each, a failing item is dropped from the results.</p>
            <select className={fieldClass} value={node.data.match ?? 'all'} onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value as 'all' | 'any', clauses: clausesOf(node.data) } })}>
              <option value="all">Match all (AND)</option>
              <option value="any">Match any (OR)</option>
            </select>
            {clausesOf(node.data).map((clause, i) => {
              const clauses = clausesOf(node.data)
              const update = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next } })
              return (
                <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                  <TokenTextEditor ref={registerEditor(`filt.${i}.left`)} className="px-2 py-1.5" value={clause.left} labelCtx={labelCtx} placeholder="Choose data from below" onFocus={focusEditor(`filt.${i}.left`)} onChange={(left) => update(clauses.map((c, j) => (j === i ? { ...c, left } : c)))} ariaLabel={`Filter ${i + 1} value`} />
                  <div className="flex gap-1.5">
                    <select className={smallField} value={clause.op} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                      {CONDITION_OPS.map((op) => <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>)}
                    </select>
                    <TokenTextEditor ref={registerEditor(`filt.${i}.right`)} className="min-w-0 flex-1 px-2 py-1.5" value={clause.right} labelCtx={labelCtx} placeholder="80" onFocus={focusEditor(`filt.${i}.right`)} onChange={(right) => update(clauses.map((c, j) => (j === i ? { ...c, right } : c)))} ariaLabel={`Filter ${i + 1} comparison value`} />
                    {clauses.length > 1 && (
                      <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove condition"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </div>
                </div>
              )
            })}
            <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, clauses: [...clausesOf(node.data), { left: '', op: 'contains', right: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add condition
            </button>
            <div><DataTree fields={dataFields} onInsert={insertToken} /></div>
          </div>
        )}

        {node.type === 'switch' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">The first matching case routes the flow; anything unmatched follows the <strong>default</strong> branch on the canvas.</p>
            {node.data.cases.map((c, i) => (
              <div key={c.id} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                <div className="flex gap-1.5">
                  <input className={`${smallField} flex-1`} value={c.label ?? ''} placeholder={`Case ${i + 1} label`} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} />
                  {node.data.cases.length > 1 && (
                    <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, cases: node.data.cases.filter((_, j) => j !== i) } })} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove case"><Trash2 className="h-4 w-4" /></button>
                  )}
                </div>
                <TokenTextEditor ref={registerEditor(`sw.${i}.left`)} className="px-2 py-1.5" value={c.left} labelCtx={labelCtx} placeholder="Choose data from below" onFocus={focusEditor(`sw.${i}.left`)} onChange={(left) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, left } : x)) } })} ariaLabel={`Case ${i + 1} value`} />
                <div className="flex gap-1.5">
                  <select className={smallField} value={c.op} onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, op: e.target.value as ConditionOp } : x)) } })}>
                    {CONDITION_OPS.map((op) => <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>)}
                  </select>
                  <TokenTextEditor ref={registerEditor(`sw.${i}.right`)} className="min-w-0 flex-1 px-2 py-1.5" value={c.right} labelCtx={labelCtx} placeholder="enterprise" onFocus={focusEditor(`sw.${i}.right`)} onChange={(right) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, right } : x)) } })} ariaLabel={`Case ${i + 1} comparison value`} />
                </div>
              </div>
            ))}
            <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, cases: [...node.data.cases, { id: `case${node.data.cases.length + 1}-${Math.random().toString(36).slice(2, 6)}`, left: '', op: 'contains', right: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add case
            </button>
            <div><DataTree fields={dataFields} onInsert={insertToken} /></div>
          </div>
        )}

        {node.type === 'stop' && (
          <div>
            <label className={labelClass}>Reason (optional)</label>
            <input className={fieldClass} value={node.data.reason ?? ''} placeholder="Why the flow stops here" onChange={(e) => onChange({ ...node, data: { ...node.data, reason: e.target.value } })} />
            <p className="mt-1.5 text-xs text-muted-foreground">Ends the flow early; later steps are skipped.</p>
          </div>
        )}

        {node.type === 'variable' && (
          <VariableEditor
            node={node}
            variableNames={variableNames ?? []}
            onChange={onChange}
            dataFields={dataFields}
            labelCtx={labelCtx}
            registerEditor={registerEditor}
            focusEditor={focusEditor}
            insertToken={insertToken}
            blockActive={blockActive}
            unblockActive={unblockActive}
          />
        )}

        {node.type === 'data' && (
          <DataEditor
            node={node}
            onChange={onChange}
            dataFields={dataFields}
            labelCtx={labelCtx}
            registerEditor={registerEditor}
            focusEditor={focusEditor}
            insertToken={insertToken}
            blockActive={blockActive}
            unblockActive={unblockActive}
          />
        )}

        {node.type === 'humanReview' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Message</label>
              <TokenTextEditor
                ref={registerEditor('hr.message')}
                multiline
                rows={5}
                value={node.data.message}
                labelCtx={labelCtx}
                placeholder="What should the person be asked? Their reply becomes this step's output."
                onFocus={focusEditor('hr.message')}
                onChange={(message) => onChange({ ...node, data: { ...node.data, message } })}
                ariaLabel="Message"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            {/* No org-member roster is fetched anywhere in the builder today, so
                an assignee select would need a new members API + fetch. v1 keeps
                the engine default (assigneeUserId unset = run owner is asked). */}
            <div>
              <label className={labelClass}>Assigned to</label>
              <p className="rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">The flow owner is asked by default. The run pauses here until they reply, and the reply becomes this step&apos;s output.</p>
            </div>
          </div>
        )}
      </div>

      {!isTrigger && (
        <div className="flex gap-2 border-t border-border p-4">
          {onDuplicate && (
            <Button variant="outline" className="flex-1" onClick={onDuplicate}>
              <Copy className="mr-1.5 h-4 w-4" /> Duplicate
            </Button>
          )}
          <Button variant="outline" className="flex-1 text-red-600 hover:text-red-700" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Delete
          </Button>
        </div>
      )}
    </div>
  )
}

type TokenEditorPlumbing = {
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  insertToken: (token: string) => void
  blockActive: () => void
  unblockActive: () => void
}

/** Variable step editor: op, name (a select of upstream initializes for mutations), type, value. */
function VariableEditor({
  node,
  variableNames,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: {
  node: Extract<FlowNode, { type: 'variable' }>
  variableNames: string[]
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const isInitialize = node.data.op === 'initialize'
  const currentName = node.data.name.trim()
  // Mutation ops pick from variables initialized earlier; keep a name that is
  // not in that list selectable (it may live in a sibling branch).
  const nameOptions = [...variableNames, ...(currentName && !variableNames.includes(currentName) ? [currentName] : [])]
  const setOp = (op: VariableOp) =>
    onChange({ ...node, data: { ...node.data, op, varType: op === 'initialize' ? node.data.varType ?? 'string' : undefined } })
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass}>Operation</label>
        <select className={fieldClass} value={node.data.op} onChange={(e) => setOp(e.target.value as VariableOp)}>
          {VARIABLE_OPS.map((op) => (
            <option key={op} value={op}>
              {VARIABLE_OP_LABELS[op]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass}>Name</label>
        {isInitialize || nameOptions.length === 0 ? (
          <input
            className={fieldClass}
            value={node.data.name}
            placeholder="Enter variable name"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, name: e.target.value } })}
            aria-label="Variable name"
          />
        ) : (
          <select
            className={fieldClass}
            value={currentName}
            onChange={(e) => onChange({ ...node, data: { ...node.data, name: e.target.value } })}
            aria-label="Variable name"
          >
            <option value="">Choose a variable…</option>
            {nameOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {!isInitialize && nameOptions.length === 0 && (
          <p className="mt-1.5 text-xs text-muted-foreground">No variables are initialized earlier in this flow — add an Initialize variable step first, or type the name it will use.</p>
        )}
      </div>
      {isInitialize && (
        <div>
          <label className={labelClass}>Type</label>
          <select
            className={fieldClass}
            value={node.data.varType ?? 'string'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, varType: e.target.value as VariableType } })}
          >
            {VARIABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {VARIABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className={labelClass}>Value {variableValueOptional(node.data.op) ? '(optional)' : ''}</label>
        <TokenTextEditor
          ref={registerEditor('var.value')}
          value={node.data.value ?? ''}
          labelCtx={labelCtx}
          placeholder={VARIABLE_VALUE_PLACEHOLDER[node.data.op]}
          onFocus={focusEditor('var.value')}
          onChange={(value) => onChange({ ...node, data: { ...node.data, value } })}
          ariaLabel="Variable value"
        />
        <div className="mt-2">
          <DataTree fields={dataFields} onInsert={insertToken} />
        </div>
      </div>
    </div>
  )
}

/** Data operation step editor: op, input, and the op-specific extras. */
function DataEditor({
  node,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: {
  node: Extract<FlowNode, { type: 'data' }>
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const op = node.data.op
  const clauses = node.data.clauses?.length ? node.data.clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]
  const fields = node.data.fields?.length ? node.data.fields : [{ name: '', value: '' }]
  const setOp = (next: DataOp) => {
    // Ops with required list config start with one empty row so the editor
    // opens ready to fill in.
    const nextClauses = next === 'filterArray' && !(node.data.clauses ?? []).length ? [{ left: '', op: 'contains' as ConditionOp, right: '' }] : node.data.clauses
    const nextFields = next === 'select' && !(node.data.fields ?? []).length ? [{ name: '', value: '' }] : node.data.fields
    onChange({ ...node, data: { ...node.data, op: next, clauses: nextClauses, fields: nextFields } })
  }
  const setClauses = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next } })
  const setFields = (next: { name: string; value: string }[]) => onChange({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass}>Operation</label>
        <select className={fieldClass} value={op} onChange={(e) => setOp(e.target.value as DataOp)}>
          {DATA_OPS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_OP_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass}>Input</label>
        <TokenTextEditor
          ref={registerEditor('data.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          placeholder={DATA_OP_INPUT_PLACEHOLDER[op]}
          onFocus={focusEditor('data.input')}
          onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
          ariaLabel="Input"
        />
      </div>
      {op === 'join' && (
        <div>
          <label className={labelClass}>Join with (optional)</label>
          <input
            className={fieldClass}
            value={node.data.separator ?? ''}
            placeholder="Defaults to a comma"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, separator: e.target.value || undefined } })}
            aria-label="Join with"
          />
        </div>
      )}
      {op === 'parseJson' && (
        <div>
          <label className={labelClass}>Schema (optional)</label>
          <textarea
            rows={4}
            className={`${areaClass} font-mono text-xs`}
            value={node.data.schema ?? ''}
            placeholder="A JSON Schema describing the parsed shape"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, schema: e.target.value || undefined } })}
            aria-label="Schema"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">Optional — stored for reference.</p>
        </div>
      )}
      {op === 'filterArray' && (
        <div className="space-y-3">
          <label className={labelClass}>Conditions</label>
          {clauses.map((clause, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <TokenTextEditor
                ref={registerEditor(`data.clause.${i}.left`)}
                className="px-2 py-1.5"
                value={clause.left}
                labelCtx={labelCtx}
                placeholder="Item field to check"
                onFocus={focusEditor(`data.clause.${i}.left`)}
                onChange={(left) => setClauses(clauses.map((c, j) => (j === i ? { ...c, left } : c)))}
                ariaLabel={`Condition ${i + 1} value`}
              />
              <div className="flex gap-1.5">
                <select className={smallField} value={clause.op} onChange={(e) => setClauses(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                  {CONDITION_OPS.map((entry) => (
                    <option key={entry} value={entry}>
                      {CONDITION_OP_LABELS[entry]}
                    </option>
                  ))}
                </select>
                <TokenTextEditor
                  ref={registerEditor(`data.clause.${i}.right`)}
                  className="min-w-0 flex-1 px-2 py-1.5"
                  value={clause.right}
                  labelCtx={labelCtx}
                  placeholder="Compare to"
                  onFocus={focusEditor(`data.clause.${i}.right`)}
                  onChange={(right) => setClauses(clauses.map((c, j) => (j === i ? { ...c, right } : c)))}
                  ariaLabel={`Condition ${i + 1} comparison value`}
                />
                {clauses.length > 1 && (
                  <button type="button" onClick={() => setClauses(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove condition">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setClauses([...clauses, { left: '', op: 'contains', right: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add condition
          </button>
          <p className="text-[11px] text-muted-foreground">Every condition checks one item of the list at a time; only items where all conditions pass are kept.</p>
        </div>
      )}
      {op === 'select' && (
        <div className="space-y-3">
          <label className={labelClass}>Fields</label>
          {fields.map((field, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <div className="flex gap-1.5">
                <input
                  className={`${smallField} flex-1`}
                  value={field.name}
                  placeholder="Output field"
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
                />
                {fields.length > 1 && (
                  <button type="button" onClick={() => setFields(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove field">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <TokenTextEditor
                ref={registerEditor(`data.field.${i}.value`)}
                className="px-2 py-1.5"
                value={field.value}
                labelCtx={labelCtx}
                placeholder="Value for this field"
                onFocus={focusEditor(`data.field.${i}.value`)}
                onChange={(value) => setFields(fields.map((f, j) => (j === i ? { ...f, value } : f)))}
                ariaLabel={`Value for field ${field.name || i + 1}`}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFields([...fields, { name: '', value: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add field
          </button>
        </div>
      )}
      <div>
        <DataTree fields={dataFields} onInsert={insertToken} />
      </div>
      <p className="text-xs text-muted-foreground">{DATA_OP_HELPER[op]}</p>
    </div>
  )
}

/** Declare a step's output fields so downstream steps can map from them. */
function OutputFieldsEditor({
  fields,
  onChange,
  blockActive,
  unblockActive,
}: {
  fields: OutputField[]
  onChange: (fields: OutputField[]) => void
  blockActive: () => void
  unblockActive: () => void
}) {
  return (
    <div>
      <label className={labelClass}>Output fields (optional)</label>
      <p className="-mt-1 mb-2 text-[11px] text-muted-foreground">Declare what this step returns so later steps can map its fields. Fields also appear once the step has run.</p>
      <div className="space-y-1.5">
        {fields.map((field, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              className={`${smallField} flex-1`}
              value={field.name}
              placeholder="fieldName"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
            />
            <select className={smallField} value={field.type} onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, type: e.target.value as OutputField['type'] } : f)))}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove field">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...fields, { name: '', type: 'any' }])} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
        <Plus className="h-3.5 w-3.5" /> Add field
      </button>
    </div>
  )
}

/** Declare the payload fields a manual/scheduled/webhook trigger expects. */
function InputFieldsEditor({ fields, onChange }: { fields: TriggerInputField[]; onChange: (fields: TriggerInputField[]) => void }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
      <label className={labelClass}>Expected input fields</label>
      <p className="-mt-1 mb-2 text-[11px] text-muted-foreground">
        Name the values this flow expects. Downstream steps can pick them as Run input fields instead of typing template paths.
      </p>
      <div className="space-y-2">
        {fields.map((field, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border border-border bg-background p-2">
            <div className="flex gap-1.5">
              <input
                className={`${smallField} min-w-0 flex-1`}
                value={field.name}
                placeholder="account"
                onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
              />
              <select className={smallField} value={field.type} onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, type: e.target.value as OutputField['type'] } : f)))}>
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove input field">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <input
              className={`${smallField} w-full`}
              value={field.description ?? ''}
              placeholder="What should the user or webhook send here?"
              onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, description: e.target.value || undefined } : f)))}
            />
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={field.required === true}
                onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, required: e.target.checked || undefined } : f)))}
                className="h-3.5 w-3.5 rounded border-border"
              />
              Required — the run must supply this value
            </label>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...fields, { name: '', type: 'string' }])} className="mt-2 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
        <Plus className="h-3.5 w-3.5" /> Add input field
      </button>
    </div>
  )
}

/** The trigger node's editor: manual, a real schedule, or an inbound webhook. */
/**
 * "Only run when…" — optional trigger-level filter. A run whose trigger
 * payload fails these clauses is skipped before any step executes (see
 * interpretFlow). Empty clause list = no filter (the stored `filter` is
 * dropped so old graphs stay byte-identical).
 */
function TriggerFilterEditor({
  filter,
  onChange,
}: {
  filter: TriggerData['filter']
  onChange: (filter: TriggerData['filter']) => void
}) {
  const clauses = filter?.clauses ?? []
  const update = (next: ConditionClause[]) =>
    onChange(next.length ? { match: filter?.match ?? 'all', clauses: next } : undefined)
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className={labelClass}>Only run when…</label>
        {clauses.length > 1 && (
          <select
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
            value={filter?.match ?? 'all'}
            onChange={(e) => onChange({ match: e.target.value as 'all' | 'any', clauses })}
            aria-label="Match all or any filter conditions"
          >
            <option value="all">All match</option>
            <option value="any">Any match</option>
          </select>
        )}
      </div>
      {clauses.map((clause, i) => (
        <div key={i} className="mt-1.5 flex items-center gap-1.5">
          <input
            className={smallField}
            value={clause.left}
            placeholder="{{trigger.input.status}}"
            onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, left: e.target.value } : c)))}
            aria-label={`Filter ${i + 1} value`}
          />
          <select
            className={smallField}
            value={clause.op}
            onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}
            aria-label={`Filter ${i + 1} operator`}
          >
            {CONDITION_OPS.map((op) => (
              <option key={op} value={op}>
                {CONDITION_OP_LABELS[op]}
              </option>
            ))}
          </select>
          <input
            className={smallField}
            value={clause.right}
            placeholder="urgent"
            onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, right: e.target.value } : c)))}
            aria-label={`Filter ${i + 1} comparison`}
          />
          <button
            type="button"
            onClick={() => update(clauses.filter((_, j) => j !== i))}
            className="px-1 text-red-500 hover:text-red-700"
            aria-label="Remove filter condition"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800"
        onClick={() => update([...clauses, { left: '', op: 'eq', right: '' }])}
      >
        + Add condition
      </button>
      <p className="mt-1 text-xs text-muted-foreground">
        Runs that don&apos;t match are skipped before any step executes.
      </p>
    </div>
  )
}

function TriggerEditor({
  flowId,
  trigger,
  onChange,
}: {
  flowId: string
  trigger: TriggerData
  onChange: (trigger: TriggerData) => void
}) {
  const [webhook, setWebhook] = useState<{ url: string; secret: string | null } | null>(null)
  const [minting, setMinting] = useState(false)
  const type = trigger.type ?? 'manual'
  const schedule = trigger.schedule ?? { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true }
  const sampleWebhookBody = JSON.stringify({ input: { account: 'Acme', priority: 'high' } }, null, 2)
  const webhookHeader = webhook?.secret ? `x-trigger-secret: ${webhook.secret}` : 'x-trigger-secret: <secret>'
  const curlExample = webhook
    ? `curl -X POST '${webhook.url}' \\\n  -H 'content-type: application/json' \\\n  -H '${webhookHeader}' \\\n  --data '${JSON.stringify({ input: { account: 'Acme', priority: 'high' } })}'`
    : ''

  const setSchedule = (patch: Partial<NonNullable<TriggerData['schedule']>>) =>
    onChange({ ...trigger, type: 'schedule', schedule: { ...schedule, ...patch, isActive: true } })

  // "Next run" preview for the schedule editor. IMPORTANT: nextOccurrence's cron
  // path does a minute-by-minute scan and has measured up to ~13s worst case —
  // far too slow to call on every render/keystroke. So this memo only ever
  // calls nextOccurrence for the fast schedule types (hourly/daily/weekly/once);
  // cron gets a static, non-computed label below instead.
  const nextRunLabel = useMemo(() => {
    if (schedule.type === 'cron') return null
    const merged: AgentSchedule = {
      type: (schedule.type as AgentSchedule['type']) ?? 'daily',
      time: schedule.time ?? '09:00',
      cron: schedule.cron ?? '',
      timezone: schedule.timezone ?? 'UTC',
      runAt: schedule.runAt,
      isActive: true,
    }
    const next = nextOccurrence(merged, new Date())
    return next ? next.toLocaleString() : 'Not scheduled'
  }, [schedule.type, schedule.time, schedule.timezone, schedule.runAt, schedule.cron])

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied.`)
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}.`)
    }
  }

  const mintWebhook = async (rotate: boolean) => {
    setMinting(true)
    try {
      const response = await fetch(`/api/flows/${flowId}/trigger-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotate }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not create the webhook URL.')
        return
      }
      setWebhook({ url: data.url, secret: data.secret })
      if (data.secret) toast.success('Webhook secret created — copy it now; it is shown only once.')
    } finally {
      setMinting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className={labelClass}>Trigger type</label>
        <select
          className={fieldClass}
          value={type}
          onChange={(e) => {
            const next = e.target.value as 'manual' | 'schedule' | 'webhook' | 'signal'
            onChange(next === 'schedule' ? { ...trigger, type: next, schedule: { ...schedule, isActive: true } } : { ...trigger, type: next })
          }}
        >
          <option value="manual">Manually trigger a flow</option>
          <option value="schedule">Schedule</option>
          <option value="webhook">When an HTTP request is received</option>
          <option value="signal">When a signal fires</option>
        </select>
      </div>

      <InputFieldsEditor
        fields={trigger.inputFields ?? []}
        onChange={(inputFields) => onChange({ ...trigger, inputFields: inputFields.length ? inputFields : undefined })}
      />

      {type !== 'manual' && (
        <TriggerFilterEditor
          filter={trigger.filter}
          onChange={(filter) => onChange({ ...trigger, filter })}
        />
      )}

      {type === 'schedule' && (
        <div className="space-y-3">
          <div>
            <label className={labelClass}>Frequency</label>
            <select className={fieldClass} value={schedule.type ?? 'daily'} onChange={(e) => setSchedule({ type: e.target.value })}>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {['daily', 'weekly', 'once'].includes(schedule.type ?? 'daily') && (
            <div>
              <label className={labelClass}>Time (HH:MM)</label>
              <input className={fieldClass} value={schedule.time ?? '09:00'} placeholder="09:00" onChange={(e) => setSchedule({ time: e.target.value })} />
            </div>
          )}
          {schedule.type === 'once' && (
            <div>
              <label className={labelClass}>Date (YYYY-MM-DD)</label>
              <input className={fieldClass} value={schedule.runAt ?? ''} placeholder="2026-07-15" onChange={(e) => setSchedule({ runAt: e.target.value })} />
            </div>
          )}
          {schedule.type === 'cron' && (
            <div>
              <label className={labelClass}>Cron expression</label>
              <input className={`${fieldClass} font-mono`} value={schedule.cron ?? ''} placeholder="0 9 * * 1-5" onChange={(e) => setSchedule({ cron: e.target.value })} />
            </div>
          )}
          <div>
            <label className={labelClass}>Timezone</label>
            <input className={fieldClass} value={schedule.timezone ?? 'UTC'} placeholder="America/Denver" onChange={(e) => setSchedule({ timezone: e.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Run input for scheduled runs (optional)</label>
            <textarea rows={2} className={fieldClass} value={trigger.input ?? ''} placeholder="Text or JSON passed to the flow each time it runs" onChange={(e) => onChange({ ...trigger, input: e.target.value || undefined })} />
          </div>
          <p className="text-xs text-muted-foreground">
            {schedule.type === 'cron' ? `Next run: per cron "${schedule.cron ?? ''}"` : `Next run: ${nextRunLabel}`}
          </p>
          <p className="text-xs text-muted-foreground">Scheduled runs execute the <strong>published</strong> version — publish the flow to arm the schedule.</p>
        </div>
      )}

      {type === 'signal' && (
        <div className="space-y-3">
          <div>
            <label className={labelClass}>Signal name</label>
            <input
              className={fieldClass}
              list="known-signals"
              value={trigger.signal ?? ''}
              placeholder="flow.completed"
              onChange={(e) => onChange({ ...trigger, signal: e.target.value || undefined })}
            />
            <datalist id="known-signals">
              {KNOWN_SIGNALS.map((signal) => (
                <option key={signal} value={signal} />
              ))}
            </datalist>
          </div>
          <p className="text-xs text-muted-foreground">
            Fires when this signal is emitted anywhere in your workspace. The signal payload arrives as the Run input. Runs the published version.
          </p>
        </div>
      )}

      {type === 'webhook' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => mintWebhook(false)} loading={minting}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" /> Get webhook URL
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => mintWebhook(true)} title="Rotate the secret (invalidates the old one)">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          {webhook && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-2.5">
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Webhook URL</p>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(webhook.url, 'Webhook URL')}>
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <p className="break-all rounded bg-background px-2 py-1.5 font-mono text-[11px]">{webhook.url}</p>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Auth header</p>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(webhookHeader, 'Auth header')}>
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <p className="break-all rounded bg-background px-2 py-1.5 font-mono text-[11px] text-amber-700 dark:text-amber-400">{webhookHeader}</p>
                {!webhook.secret && <p className="mt-1 text-[11px] text-muted-foreground">A secret already exists. Rotate to mint and display a new one.</p>}
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Example JSON body</p>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(sampleWebhookBody, 'Example JSON body')}>
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <pre className="max-h-32 overflow-auto rounded bg-background px-2 py-1.5 text-[11px]">{sampleWebhookBody}</pre>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">cURL</p>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700" onClick={() => copyText(curlExample, 'cURL example')}>
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <pre className="max-h-36 overflow-auto rounded bg-background px-2 py-1.5 text-[11px]">{curlExample}</pre>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            POST to the URL with the <code className="font-mono">x-trigger-secret</code> header; the JSON body, or its <code className="font-mono">input</code> field, becomes the flow input. Runs the <strong>published</strong> version.
          </p>
        </div>
      )}
    </div>
  )
}
