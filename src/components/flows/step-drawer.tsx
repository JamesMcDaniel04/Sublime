'use client'

import { useState } from 'react'
import { X, Trash2, Plus, Copy, Link2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CONDITION_OPS, FIELD_TYPES, type FlowNode, type ConditionOp, type ConditionClause, type OutputField } from '@/lib/flows/graph'
import { DataTree } from '@/components/flows/data-tree'
import type { DataField } from '@/lib/flows/datatree'

type EditableType = Extract<FlowNode['type'], 'agent' | 'condition' | 'loop' | 'parallel' | 'stop' | 'tool' | 'http'>
const NODE_TYPES: { value: EditableType; label: string }[] = [
  { value: 'agent', label: 'Run agent' },
  { value: 'tool', label: 'Tool call' },
  { value: 'http', label: 'HTTP request' },
  { value: 'condition', label: 'If / else' },
  { value: 'loop', label: 'For each' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'stop', label: 'Stop' },
]

export type ToolCatalog = { id: string; name: string; tools: { name: string; description: string }[] }[]

/** Frequencies the schedule editor offers (matches AgentSchedule types). */
const FREQUENCIES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Cron expression' },
  { value: 'once', label: 'Once' },
] as const

type TriggerData = {
  type?: 'manual' | 'schedule' | 'webhook'
  schedule?: { type?: string; time?: string; cron?: string; timezone?: string; runAt?: string; isActive?: boolean }
  input?: string
}

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const smallField =
  'rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function clausesOf(data: Extract<FlowNode, { type: 'condition' }>['data']): ConditionClause[] {
  if (data.clauses && data.clauses.length) return data.clauses
  if (data.left !== undefined || data.right !== undefined)
    return [{ left: data.left ?? '', op: data.op ?? 'contains', right: data.right ?? '' }]
  return [{ left: '', op: 'contains', right: '' }]
}

export function StepDrawer({
  node,
  flowId,
  agents,
  toolCatalog,
  dataFields,
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
  onChange: (node: FlowNode) => void
  onChangeType: (type: EditableType) => void
  onAddStep?: () => void
  onDuplicate?: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const isTrigger = node.type === 'trigger'
  // Which text field a datatree click inserts into (tracked on focus).
  const [activeField, setActiveField] = useState<string>('')

  const setLabel = (label: string) => onChange({ ...node, data: { ...node.data, label } } as FlowNode)

  // Append a {{token}} to whatever field is focused (defaults to agent input).
  const insertToken = (token: string) => {
    if (node.type === 'agent') {
      onChange({ ...node, data: { ...node.data, input: `${node.data.input ?? ''}${token}` } })
      return
    }
    if (node.type === 'condition') {
      const m = activeField.match(/^cond\.(\d+)\.(left|right)$/)
      const clauses = clausesOf(node.data)
      const i = m ? Number(m[1]) : 0
      const side = (m ? m[2] : 'left') as 'left' | 'right'
      onChange({ ...node, data: { ...node.data, clauses: clauses.map((c, j) => (j === i ? { ...c, [side]: `${c[side] ?? ''}${token}` } : c)), left: undefined, op: undefined, right: undefined } })
      return
    }
    if (node.type === 'loop') {
      onChange({ ...node, data: { ...node.data, over: `${node.data.over ?? ''}${token}` } })
      return
    }
    if (node.type === 'tool') {
      onChange({ ...node, data: { ...node.data, args: `${node.data.args ?? ''}${token}` } })
      return
    }
    if (node.type === 'http') {
      const field = activeField === 'http.url' ? 'url' : activeField === 'http.headers' ? 'headers' : 'body'
      const existing = (node.data as unknown as Record<string, string | undefined>)[field] ?? ''
      onChange({ ...node, data: { ...node.data, [field]: `${existing}${token}` } })
    }
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
              <input className={fieldClass} value={(node.data as { label?: string }).label ?? ''} placeholder="A short name for this step" onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Notes (optional)</label>
              <textarea
                rows={2}
                className={fieldClass}
                value={(node.data as { note?: string }).note ?? ''}
                placeholder="Why this step exists, gotchas, links…"
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
              <label className={labelClass}>Input</label>
              <textarea
                rows={4}
                className={fieldClass}
                value={node.data.input ?? ''}
                placeholder="{{trigger.input}}"
                onFocus={() => setActiveField('agent.input')}
                onChange={(e) => onChange({ ...node, data: { ...node.data, input: e.target.value } })}
              />
              <p className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Insert data</p>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>On error</label>
                <select
                  className={`${smallField} w-full`}
                  value={node.data.onError ?? 'stop'}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, onError: e.target.value as 'stop' | 'continue' } })}
                >
                  <option value="stop">Stop flow</option>
                  <option value="continue">Continue</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Retries</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  className={`${smallField} w-full`}
                  value={node.data.retries ?? 0}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, retries: Math.max(0, Math.min(5, Number(e.target.value) || 0)) } })}
                />
              </div>
            </div>
            <div>
              <label className={labelClass}>Timeout (seconds, optional)</label>
              <input
                type="number"
                min={1}
                className={fieldClass}
                value={node.data.timeoutMs ? Math.round(node.data.timeoutMs / 1000) : ''}
                placeholder="No timeout"
                onChange={(e) => {
                  const secs = Number(e.target.value)
                  onChange({ ...node, data: { ...node.data, timeoutMs: secs > 0 ? secs * 1000 : undefined } })
                }}
              />
            </div>
            <OutputFieldsEditor
              fields={node.data.outputFields ?? []}
              onChange={(outputFields) => onChange({ ...node, data: { ...node.data, outputFields: outputFields.length ? outputFields : undefined } })}
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
                  <input
                    className={`${smallField} w-full`}
                    value={clause.left}
                    placeholder="{{step.n1.output.score}}"
                    onFocus={() => setActiveField(`cond.${i}.left`)}
                    onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, left: e.target.value } : c)))}
                  />
                  <div className="flex gap-1.5">
                    <select className={smallField} value={clause.op} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                      {CONDITION_OPS.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </select>
                    <input
                      className={`${smallField} flex-1`}
                      value={clause.right}
                      placeholder="80"
                      onFocus={() => setActiveField(`cond.${i}.right`)}
                      onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, right: e.target.value } : c)))}
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
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Insert data</p>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
          </div>
        )}

        {node.type === 'loop' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Over (a list)</label>
              <input className={fieldClass} value={node.data.over} placeholder="{{step.n1.output}}" onFocus={() => setActiveField('loop.over')} onChange={(e) => onChange({ ...node, data: { ...node.data, over: e.target.value } })} />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">Runs the nested steps once per item. Click an indented card to edit it.</p>
            </div>
            <div>
              <label className={labelClass}>At a time</label>
              <input
                type="number"
                min={1}
                max={20}
                className={fieldClass}
                value={node.data.concurrency ?? 3}
                onChange={(e) => onChange({ ...node, data: { ...node.data, concurrency: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } })}
              />
            </div>
            {onAddStep && (
              <Button variant="outline" size="sm" className="w-full" onClick={onAddStep}>
                <Plus className="mr-1.5 h-4 w-4" /> Add step to loop
              </Button>
            )}
          </div>
        )}

        {node.type === 'parallel' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Runs {node.data.branches.length} branch{node.data.branches.length === 1 ? '' : 'es'} at once and merges their outputs. Click an indented card to edit a branch step.
            </p>
            {onAddStep && (
              <Button variant="outline" size="sm" className="w-full" onClick={onAddStep}>
                <Plus className="mr-1.5 h-4 w-4" /> Add parallel branch
              </Button>
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
            <div>
              <label className={labelClass}>Arguments (JSON)</label>
              <textarea
                rows={4}
                className={`${fieldClass} font-mono text-xs`}
                value={node.data.args ?? '{}'}
                placeholder={'{"query": "{{trigger.input}}"}'}
                onFocus={() => setActiveField('tool.args')}
                onChange={(e) => onChange({ ...node, data: { ...node.data, args: e.target.value } })}
              />
              <p className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Insert data</p>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
            <div>
              <label className={labelClass}>On error</label>
              <select
                className={fieldClass}
                value={node.data.onError ?? 'stop'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, onError: e.target.value as 'stop' | 'continue' } })}
              >
                <option value="stop">Stop flow</option>
                <option value="continue">Continue</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">Runs this exact tool with these arguments — deterministic, no agent in the loop.</p>
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
              <input
                className={`${smallField} flex-1`}
                value={node.data.url}
                placeholder="https://example.com/webhook"
                onFocus={() => setActiveField('http.url')}
                onChange={(e) => onChange({ ...node, data: { ...node.data, url: e.target.value } })}
              />
            </div>
            <div>
              <label className={labelClass}>Headers (JSON, optional)</label>
              <textarea
                rows={2}
                className={`${fieldClass} font-mono text-xs`}
                value={node.data.headers ?? ''}
                placeholder={'{"authorization": "Bearer …"}'}
                onFocus={() => setActiveField('http.headers')}
                onChange={(e) => onChange({ ...node, data: { ...node.data, headers: e.target.value || undefined } })}
              />
            </div>
            <div>
              <label className={labelClass}>Body</label>
              <textarea
                rows={4}
                className={`${fieldClass} font-mono text-xs`}
                value={node.data.body ?? ''}
                placeholder={'{"text": "{{step.n1.output}}"}'}
                onFocus={() => setActiveField('http.body')}
                onChange={(e) => onChange({ ...node, data: { ...node.data, body: e.target.value || undefined } })}
              />
              <p className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Insert data</p>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
            <div>
              <label className={labelClass}>On error</label>
              <select
                className={fieldClass}
                value={node.data.onError ?? 'stop'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, onError: e.target.value as 'stop' | 'continue' } })}
              >
                <option value="stop">Stop flow</option>
                <option value="continue">Continue</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">Calls an external URL (public hosts only). The response body becomes this step&apos;s output.</p>
          </div>
        )}

        {node.type === 'stop' && (
          <div>
            <label className={labelClass}>Reason (optional)</label>
            <input className={fieldClass} value={node.data.reason ?? ''} placeholder="Why the flow stops here" onChange={(e) => onChange({ ...node, data: { ...node.data, reason: e.target.value } })} />
            <p className="mt-1.5 text-xs text-muted-foreground">Ends the flow early; later steps are skipped.</p>
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

/** Declare a step's output fields so downstream steps can map from them. */
function OutputFieldsEditor({ fields, onChange }: { fields: OutputField[]; onChange: (fields: OutputField[]) => void }) {
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

/** The trigger node's editor: manual, a real schedule, or an inbound webhook. */
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

  const setSchedule = (patch: Partial<NonNullable<TriggerData['schedule']>>) =>
    onChange({ ...trigger, type: 'schedule', schedule: { ...schedule, ...patch, isActive: true } })

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
            const next = e.target.value as 'manual' | 'schedule' | 'webhook'
            onChange(next === 'schedule' ? { ...trigger, type: next, schedule: { ...schedule, isActive: true } } : { ...trigger, type: next })
          }}
        >
          <option value="manual">Manual / on run</option>
          <option value="schedule">Schedule</option>
          <option value="webhook">Webhook (external)</option>
        </select>
      </div>

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
            <label className={labelClass}>Input for scheduled runs (optional)</label>
            <textarea rows={2} className={fieldClass} value={trigger.input ?? ''} placeholder="Passed as {{trigger.input}} on each scheduled run" onChange={(e) => onChange({ ...trigger, input: e.target.value || undefined })} />
          </div>
          <p className="text-xs text-muted-foreground">Scheduled runs execute the <strong>published</strong> version — publish the flow to arm the schedule.</p>
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
            <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-2.5">
              <p className="break-all font-mono text-[11px]">{webhook.url}</p>
              {webhook.secret ? (
                <p className="break-all font-mono text-[11px] text-amber-700 dark:text-amber-400">x-trigger-secret: {webhook.secret}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">A secret already exists — rotate to mint a new one.</p>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            POST to the URL with the <code className="font-mono">x-trigger-secret</code> header; the JSON body (or its <code className="font-mono">input</code> field) becomes {'{{trigger.input}}'}. Runs the <strong>published</strong> version.
          </p>
        </div>
      )}
    </div>
  )
}
