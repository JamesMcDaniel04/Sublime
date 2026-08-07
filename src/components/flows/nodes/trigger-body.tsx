'use client'

import { useEffect, useMemo, useState } from 'react'
import { Copy, Link2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FIELD_TYPES, type ConditionClause, type FlowNode, type OutputField, type TriggerInputField } from '@/lib/flows/graph'
import { KNOWN_SIGNALS, triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { SLACK_EVENT_KINDS, type SlackEventKind } from '@/lib/slack/payload'
import { nextOccurrence, type AgentSchedule } from '@/lib/scheduling/due'
import { describeSchedule } from '@/lib/scheduling/describe-schedule'
import { useViewerTimeZone } from '@/lib/scheduling/use-viewer-time-zone'
import { Button } from '@/components/ui/button'
import { TriggerFilterEditor } from '../trigger-filter-editor'
import { INPUT_TYPES, controlClass, inputTypeForField, isRecord, labelClass, uniqueFieldName } from './field-primitives'
import type { InputKind, NodeBodyModule, NodeBodyProps } from './types'

export type TriggerData = {
  type?: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack' | 'activity' | 'poll'
  schedule?: { type?: string; time?: string; cron?: string; timezone?: string; runAt?: string; isActive?: boolean }
  input?: string
  inputFields?: TriggerInputField[]
  signal?: string
  events?: string[]
  command?: string
  channels?: string[]
  keyword?: string
  threadMemory?: boolean
  bindingId?: string
  sources?: string[]
  actions?: string[]
  entityTypes?: string[]
  webhookMethods?: string[]
  webhookAuth?: 'none' | 'header' | 'bearer' | 'basic'
  webhookHeaderName?: string
  webhookUsername?: string
  webhookPayload?: 'body' | 'request'
  webhookResponse?: 'immediate' | 'lastNode' | 'respondNode'
  /** "Only run when…": the run is skipped unless these clauses match the trigger payload. */
  filter?: { match?: 'all' | 'any'; clauses?: ConditionClause[] }
  /** Polling source: run a read action on an interval; each NEW item starts a run. */
  intervalMinutes?: number
  source?: { connectionId?: string; toolName?: string; args?: string; itemsPath?: string; idPath?: string }
}

const FREQUENCIES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Cron expression' },
  { value: 'once', label: 'Once' },
] as const

const SLACK_EVENT_LABELS: Record<SlackEventKind, string> = {
  app_mention: '@mentions of the bot',
  'message.im': 'Direct messages',
  'message.channels': 'Channel messages',
  slash_command: 'A slash command',
}

export function triggerData(node: Extract<FlowNode, { type: 'trigger' }>): TriggerData {
  return isRecord(node.data.trigger) ? (node.data.trigger as TriggerData) : { type: 'manual' }
}

function TriggerBody({
  node,
  update,
  flowId,
  toolCatalog,
}: {
  node: Extract<FlowNode, { type: 'trigger' }>
  update: (node: FlowNode) => void
  flowId?: string
  toolCatalog: NodeBodyProps['toolCatalog']
}) {
  const [choosingInput, setChoosingInput] = useState(false)
  const [webhook, setWebhook] = useState<{ url: string; testUrl?: string; secret: string | null } | null>(null)
  const [minting, setMinting] = useState(false)
  const [slackBindings, setSlackBindings] = useState<{ id: string; teamName: string | null; status: string; ingressUrl: string }[]>([])
  const [slackChannels, setSlackChannels] = useState<{ id: string; name: string; isPrivate: boolean; isMember: boolean }[]>([])
  const trigger = triggerData(node)
  const type = trigger.type ?? 'manual'
  const schedule = trigger.schedule ?? { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true }
  const fields = triggerInputFieldsFromTrigger(trigger)
  const setTrigger = (next: TriggerData) => update({ ...node, data: { ...node.data, trigger: next } })
  const addField = (kind: InputKind) => {
    const option = INPUT_TYPES.find((inputType) => inputType.id === kind) ?? INPUT_TYPES[0]
    setTrigger({
      ...trigger,
      inputFields: [
        ...fields,
        {
          name: uniqueFieldName(option.name, fields),
          type: option.fieldType,
          description: option.description,
        },
      ],
    })
    setChoosingInput(false)
  }
  const updateField = (index: number, patch: Partial<TriggerInputField>) => {
    setTrigger({
      ...trigger,
      inputFields: fields.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)),
    })
  }
  const removeField = (index: number) => {
    setTrigger({ ...trigger, inputFields: fields.filter((_, fieldIndex) => fieldIndex !== index) })
  }

  useEffect(() => {
    if (type !== 'slack') return
    let cancelled = false
    fetch('/api/slack/connections')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSlackBindings(data.connections ?? [])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [type])

  const slackBinding = slackBindings.find((binding) => binding.id === trigger.bindingId) ?? slackBindings[0] ?? null

  useEffect(() => {
    if (type !== 'slack' || !slackBinding?.id) {
      setSlackChannels([])
      return
    }
    let cancelled = false
    fetch(`/api/slack/connections/${encodeURIComponent(slackBinding.id)}/channels`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setSlackChannels(data.channels ?? []) })
      .catch(() => { if (!cancelled) setSlackChannels([]) })
    return () => { cancelled = true }
  }, [type, slackBinding?.id])

  const setSchedule = (patch: Partial<NonNullable<TriggerData['schedule']>>) =>
    setTrigger({ ...trigger, type: 'schedule', schedule: { ...schedule, ...patch, isActive: true } })

  // "Next run" preview for the schedule editor. IMPORTANT: nextOccurrence's cron
  // path does a minute-by-minute scan and has measured up to ~13s worst case —
  // far too slow to call on every render/keystroke. So this memo only ever
  // calls nextOccurrence for the fast schedule types (hourly/daily/weekly/once);
  // cron gets a static, non-computed label below instead.
  const viewerTimeZone = useViewerTimeZone(schedule.timezone ?? 'UTC')

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

  const sampleWebhookBody = JSON.stringify({ input: { account: 'Acme', priority: 'high' } }, null, 2)
  const webhookHeader = webhook?.secret ? `x-trigger-secret: ${webhook.secret}` : 'x-trigger-secret: <secret>'
  const curlExample = webhook
    ? `curl -X POST '${webhook.url}' \\\n  -H 'content-type: application/json' \\\n  -H '${webhookHeader}' \\\n  --data '${JSON.stringify({ input: { account: 'Acme', priority: 'high' } })}'`
    : ''

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied.`)
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}.`)
    }
  }

  const mintWebhook = async (rotate: boolean) => {
    if (!flowId) return
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
      setWebhook({ url: data.url, testUrl: data.testUrl, secret: data.secret })
      if (data.secret) toast.success('Webhook secret created — copy it now; it is shown only once.')
    } finally {
      setMinting(false)
    }
  }

  const copyBlock = (label: string, value: string, valueClass?: string, pre?: boolean) => (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:text-blue-900" onClick={() => copyText(value, label)}>
          <Copy className="h-3 w-3" /> Copy
        </button>
      </div>
      {pre ? (
        <pre className={cn('max-h-36 overflow-auto rounded bg-background px-2 py-1.5 text-[11px]', valueClass)}>{value}</pre>
      ) : (
        <p className={cn('break-all rounded bg-background px-2 py-1.5 font-mono text-[11px]', valueClass)}>{value}</p>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Trigger type</label>
        <select
          className={controlClass}
          value={type}
          onChange={(event) => {
            const next = event.target.value as NonNullable<TriggerData['type']>
            setTrigger(next === 'schedule' ? { ...trigger, type: next, schedule: { ...schedule, isActive: true } } : { ...trigger, type: next })
          }}
        >
          <option value="manual">Manually trigger a flow</option>
          <option value="schedule">Schedule</option>
          <option value="webhook">When an HTTP request is received</option>
          <option value="signal">When a signal fires</option>
          <option value="slack">When a Slack message arrives</option>
          <option value="activity">When connected activity occurs</option>
          <option value="poll">When new items appear (polling)</option>
        </select>
      </div>

      {type === 'schedule' && (
        <div className="space-y-3">
          <div className="grid gap-2">
            <label className={labelClass}>Frequency</label>
            <select className={controlClass} value={schedule.type ?? 'daily'} onChange={(event) => setSchedule({ type: event.target.value })}>
              {FREQUENCIES.map((frequency) => (
                <option key={frequency.value} value={frequency.value}>
                  {frequency.label}
                </option>
              ))}
            </select>
          </div>
          {['daily', 'weekly', 'once'].includes(schedule.type ?? 'daily') && (
            <div className="grid gap-2">
              <label className={labelClass}>Time (HH:MM)</label>
              <input className={controlClass} value={schedule.time ?? '09:00'} placeholder="09:00" onChange={(event) => setSchedule({ time: event.target.value })} />
            </div>
          )}
          {schedule.type === 'once' && (
            <div className="grid gap-2">
              <label className={labelClass}>Date (YYYY-MM-DD)</label>
              <input className={controlClass} value={schedule.runAt ?? ''} placeholder="2026-07-15" onChange={(event) => setSchedule({ runAt: event.target.value })} />
            </div>
          )}
          {schedule.type === 'cron' && (
            <div className="grid gap-2">
              <label className={labelClass}>Cron expression</label>
              <input className={cn(controlClass, 'font-mono')} value={schedule.cron ?? ''} placeholder="0 9 * * 1-5" onChange={(event) => setSchedule({ cron: event.target.value })} />
            </div>
          )}
          <div className="grid gap-2">
            <label className={labelClass}>Timezone</label>
            <input className={controlClass} value={schedule.timezone ?? 'UTC'} placeholder="America/Denver" onChange={(event) => setSchedule({ timezone: event.target.value })} />
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Run input for scheduled runs (optional)</label>
            <textarea
              rows={2}
              className={cn(controlClass, 'h-auto min-h-[64px] resize-y py-2')}
              value={trigger.input ?? ''}
              placeholder="Text or JSON passed to the flow each time it runs"
              onChange={(event) => setTrigger({ ...trigger, input: event.target.value || undefined })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {schedule.type === 'cron'
              ? `Next run: ${describeSchedule({ ...schedule, type: 'cron' }, viewerTimeZone, new Date())}`
              : `Next run: ${nextRunLabel}`}
          </p>
          <p className="text-xs text-muted-foreground">Scheduled runs execute the <strong>published</strong> version — publish the flow to arm the schedule.</p>
        </div>
      )}

      {type === 'signal' && (
        <div className="space-y-3">
          <div className="grid gap-2">
            <label className={labelClass}>Signal name</label>
            <input
              className={controlClass}
              list={`known-signals-${node.id}`}
              value={trigger.signal ?? ''}
              placeholder="flow.completed"
              onChange={(event) => setTrigger({ ...trigger, signal: event.target.value || undefined })}
            />
            <datalist id={`known-signals-${node.id}`}>
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

      {type === 'poll' && (() => {
        const source = trigger.source ?? {}
        const setSource = (patch: Partial<NonNullable<TriggerData['source']>>) =>
          setTrigger({ ...trigger, type: 'poll', source: { ...source, ...patch } })
        const connection = toolCatalog.find((entry) => entry.id === source.connectionId)
        return (
          <div className="space-y-3">
            <div className="grid gap-2">
              <label className={labelClass}>Connection</label>
              <select
                className={controlClass}
                value={source.connectionId ?? ''}
                onChange={(event) => setSource({ connectionId: event.target.value || undefined, toolName: undefined })}
              >
                <option value="">Select a connection…</option>
                {toolCatalog.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.name}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <label className={labelClass}>Read action to poll</label>
              <select
                className={controlClass}
                value={source.toolName ?? ''}
                disabled={!connection}
                onChange={(event) => setSource({ toolName: event.target.value || undefined })}
              >
                <option value="">{connection ? 'Select an action…' : 'Choose a connection first'}</option>
                {(connection?.tools ?? []).map((tool) => (
                  <option key={tool.name} value={tool.name}>{tool.name}</option>
                ))}
              </select>
            </div>
            <label className={labelClass}>
              Action arguments (JSON, optional)
              <textarea
                className={cn(controlClass, 'min-h-[64px] font-mono text-[11px]')}
                value={source.args ?? ''}
                onChange={(event) => setSource({ args: event.target.value || undefined })}
                placeholder='{"range": "Sheet1!A:D"}'
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className={labelClass}>
                Check every (minutes)
                <input
                  type="number"
                  min={5}
                  className={controlClass}
                  value={trigger.intervalMinutes ?? 15}
                  onChange={(event) => setTrigger({ ...trigger, type: 'poll', intervalMinutes: Math.max(5, Number(event.target.value) || 15) })}
                />
              </label>
              <label className={labelClass}>
                Unique id field
                <input
                  className={controlClass}
                  value={source.idPath ?? ''}
                  onChange={(event) => setSource({ idPath: event.target.value || undefined })}
                  placeholder="id"
                />
              </label>
            </div>
            <label className={labelClass}>
              Items path (optional)
              <input
                className={controlClass}
                value={source.itemsPath ?? ''}
                onChange={(event) => setSource({ itemsPath: event.target.value || undefined })}
                placeholder="data.records"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              The action runs on the interval (5 minute minimum). Each <strong>new</strong> item — identified by the id field, or a content hash when blank — starts one run with the item as the flow input. The first check records what already exists without running. Runs the published version.
            </p>
          </div>
        )
      })()}

      {type === 'activity' && <div className="space-y-3">
        <label className={labelClass}>Sources (optional)<input className={controlClass} value={(trigger.sources ?? []).join(', ')} onChange={(event) => setTrigger({ ...trigger, sources: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="slack, github" /></label>
        <label className={labelClass}>Actions (optional)<input className={controlClass} value={(trigger.actions ?? []).join(', ')} onChange={(event) => setTrigger({ ...trigger, actions: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="created, updated" /></label>
        <label className={labelClass}>Entity types (optional)<input className={controlClass} value={(trigger.entityTypes ?? []).join(', ')} onChange={(event) => setTrigger({ ...trigger, entityTypes: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="issue, message" /></label>
        <p className="text-xs text-muted-foreground">Filters normalized live activity from connected integrations. Leave a field blank to accept any value.</p>
      </div>}

      {type === 'webhook' && flowId && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>Method<select className={controlClass} value={trigger.webhookMethods?.[0] ?? 'POST'} onChange={(event) => setTrigger({ ...trigger, webhookMethods: [event.target.value] })}>{['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map((method) => <option key={method}>{method}</option>)}</select></label>
            <label className={labelClass}>Authentication<select className={controlClass} value={trigger.webhookAuth ?? 'header'} onChange={(event) => setTrigger({ ...trigger, webhookAuth: event.target.value as TriggerData['webhookAuth'] })}><option value="header">Secret header</option><option value="bearer">Bearer token</option><option value="basic">Basic auth</option><option value="none">None</option></select></label>
            <label className={labelClass}>Payload<select className={controlClass} value={trigger.webhookPayload ?? 'body'} onChange={(event) => setTrigger({ ...trigger, webhookPayload: event.target.value as TriggerData['webhookPayload'] })}><option value="body">Body only (compatible)</option><option value="request">Full request</option></select></label>
            <label className={labelClass}>Response<select className={controlClass} value={trigger.webhookResponse ?? 'immediate'} onChange={(event) => setTrigger({ ...trigger, webhookResponse: event.target.value as TriggerData['webhookResponse'] })}><option value="immediate">Run receipt</option><option value="lastNode">Last step output</option><option value="respondNode">Respond node</option></select></label>
          </div>
          {(trigger.webhookAuth ?? 'header') === 'header' && <label className={labelClass}>Secret header name<input className={controlClass} value={trigger.webhookHeaderName ?? 'x-trigger-secret'} onChange={(event) => setTrigger({ ...trigger, webhookHeaderName: event.target.value || undefined })} /></label>}
          {trigger.webhookAuth === 'none' && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
              <strong>No authentication:</strong> anyone who knows this webhook URL can run this flow. Only use this for
              services that can&apos;t send auth headers, and treat the URL itself as a secret.
            </p>
          )}
          {trigger.webhookAuth === 'basic' && <label className={labelClass}>Basic auth username<input className={controlClass} value={trigger.webhookUsername ?? ''} onChange={(event) => setTrigger({ ...trigger, webhookUsername: event.target.value || undefined })} placeholder="webhook" /></label>}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => mintWebhook(false)} loading={minting}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" /> Get webhook URL
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => mintWebhook(true)} title="Rotate the secret (invalidates the old one)">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          {webhook && (
            <div className="space-y-3 rounded-lg border border-border bg-muted p-2.5">
              {copyBlock('Webhook URL', webhook.url)}
              {webhook.testUrl && copyBlock('Test URL (runs current draft)', webhook.testUrl)}
              <div>
                {copyBlock('Auth header', webhookHeader, 'text-amber-700')}
                {!webhook.secret && <p className="mt-1 text-[11px] text-muted-foreground">A secret already exists. Rotate to mint and display a new one.</p>}
              </div>
              {copyBlock('Example JSON body', sampleWebhookBody, 'max-h-32', true)}
              {copyBlock('cURL', curlExample, undefined, true)}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            POST to the URL with the <code className="font-mono">x-trigger-secret</code> header; the JSON body, or its <code className="font-mono">input</code> field, becomes the flow input. Runs the <strong>published</strong> version.
          </p>
        </div>
      )}

      {type === 'slack' && (
        <div className="space-y-3">
          {slackBindings.length > 0 && (
            <div className="grid gap-2">
              <label className={labelClass}>Slack workspace</label>
              <select
                className={controlClass}
                value={slackBinding?.id ?? ''}
                onChange={(event) => setTrigger({ ...trigger, bindingId: event.target.value || undefined })}
              >
                {slackBindings.map((binding) => <option key={binding.id} value={binding.id}>{binding.teamName || binding.id}</option>)}
              </select>
            </div>
          )}
          <div className="grid gap-2">
            <label className={labelClass}>Respond to</label>
            {SLACK_EVENT_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={(trigger.events ?? []).includes(kind)}
                  onChange={(event) => {
                    const events = new Set(trigger.events ?? [])
                    if (event.target.checked) events.add(kind)
                    else events.delete(kind)
                    setTrigger({ ...trigger, events: Array.from(events) })
                  }}
                />
                {SLACK_EVENT_LABELS[kind]}
              </label>
            ))}
          </div>
          {(trigger.events ?? []).includes('slash_command') && (
            <div className="grid gap-2">
              <label className={labelClass}>Slash command</label>
              <input className={cn(controlClass, 'font-mono')} value={trigger.command ?? ''} placeholder="/deploy" onChange={(event) => setTrigger({ ...trigger, command: event.target.value || undefined })} />
            </div>
          )}
          <div className="grid gap-2">
            <label className={labelClass}>Channels to watch (optional)</label>
            {slackChannels.length > 0 ? (
              <select
                multiple
                className={cn(controlClass, 'h-32 py-2')}
                value={trigger.channels ?? []}
                onChange={(event) => {
                  const channels = Array.from(event.currentTarget.selectedOptions, (option) => option.value)
                  setTrigger({ ...trigger, channels: channels.length ? channels : undefined })
                }}
              >
                {slackChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>#{channel.name}{channel.isPrivate ? ' (private)' : ''}{channel.isMember ? '' : ' — bot not joined'}</option>
                ))}
              </select>
            ) : (
              <input
                className={cn(controlClass, 'font-mono')}
                value={(trigger.channels ?? []).join(', ')}
                placeholder="C0123ABC, C0456DEF"
                onChange={(event) => {
                  const channels = event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean)
                  setTrigger({ ...trigger, channels: channels.length ? channels : undefined })
                }}
              />
            )}
            <p className="text-xs text-muted-foreground">Loaded from the selected Slack connection. Hold ⌘/Ctrl to select more than one.</p>
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Only when the message contains (optional)</label>
            <input className={controlClass} value={trigger.keyword ?? ''} placeholder="deploy" onChange={(event) => setTrigger({ ...trigger, keyword: event.target.value || undefined })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={trigger.threadMemory === true} onChange={(event) => setTrigger({ ...trigger, threadMemory: event.target.checked || undefined })} />
            Remember the conversation within a thread
          </label>
          {slackBinding ? (
            <div className="space-y-2 rounded-lg border border-border bg-muted p-2.5">
              <p className="text-xs text-muted-foreground">
                Slack bot: <strong>{slackBinding.teamName ?? 'Connected workspace'}</strong> ({slackBinding.status})
              </p>
              {copyBlock('Ingress URL', slackBinding.ingressUrl)}
            </div>
          ) : (
            <p className="text-xs text-amber-700">No Slack bot connected — add one on the Integrations page first.</p>
          )}
          <p className="text-xs text-muted-foreground">
            The Slack message arrives as <code className="font-mono">{'{{trigger.input.text}}'}</code> (plus channel, user, ts). Runs the <strong>published</strong> version and replies into the originating thread.
          </p>
        </div>
      )}

      {fields.length > 0 && (
        <div className="space-y-3">
          {fields.map((field, fieldIndex) => {
            const inputType = inputTypeForField(field)
            const InputIcon = inputType.icon
            return (
              <div key={`${field.name}-${fieldIndex}`} className="grid gap-3 border-b border-border pb-3 sm:grid-cols-[42px_minmax(110px,0.7fr)_auto_minmax(140px,1fr)_auto_36px]">
                <span className={cn('flex h-10 w-10 items-center justify-center rounded-full', inputType.tone)}>
                  <InputIcon className="h-5 w-5" />
                </span>
                <input
                  value={field.name}
                  onChange={(event) => updateField(fieldIndex, { name: event.target.value })}
                  className={controlClass}
                  placeholder={inputType.label}
                  aria-label="Input name"
                />
                <select
                  value={field.type}
                  onChange={(event) => updateField(fieldIndex, { type: event.target.value as OutputField['type'] })}
                  className={cn(controlClass, 'px-2')}
                  aria-label="Input field type"
                >
                  {FIELD_TYPES.map((fieldType) => (
                    <option key={fieldType} value={fieldType}>
                      {fieldType}
                    </option>
                  ))}
                </select>
                <input
                  value={field.description ?? ''}
                  onChange={(event) => updateField(fieldIndex, { description: event.target.value })}
                  className={controlClass}
                  placeholder={inputType.description}
                  aria-label="Prompt shown for input"
                />
                <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" title="The run must supply this value">
                  <input
                    type="checkbox"
                    checked={field.required === true}
                    onChange={(event) => updateField(fieldIndex, { required: event.target.checked || undefined })}
                    className="h-4 w-4 rounded border-border text-blue-600"
                  />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => removeField(fieldIndex)}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove input"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {choosingInput ? (
        <div className="rounded-xl border border-border bg-muted p-3">
          <p className="mb-3 text-sm font-semibold text-foreground">Choose the type of user input</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {INPUT_TYPES.map((type) => {
              const InputIcon = type.icon
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => addField(type.id)}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
                >
                  <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', type.tone)}>
                    <InputIcon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-foreground">{type.label}</span>
                    <span className="block text-xs text-muted-foreground">{type.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setChoosingInput(true)}
          className="flex w-full items-center gap-3 rounded-lg py-2 text-left text-base font-semibold text-muted-foreground hover:text-blue-700"
        >
          <Plus className="h-5 w-5" /> Add an input
        </button>
      )}

      {type !== 'manual' && (
        <TriggerFilterEditor
          filter={trigger.filter}
          onChange={(filter) => setTrigger({ ...trigger, filter })}
          labelClass={labelClass}
          fieldClass={cn(controlClass, 'h-9 min-w-0 flex-1 px-2')}
          addButtonClass="mt-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900"
          helperClass="mt-1 text-xs text-muted-foreground"
        />
      )}
    </div>
  )
}

// The trigger's shape is validated per-subtype (MISSING_SCHEDULE, MISSING_CRON,
// MISSING_SLACK_EVENTS, ...) rather than by one data key.
export const triggerModule: NodeBodyModule = {
  Body: ({ node, update, flowId, toolCatalog }: NodeBodyProps) => (
    <TriggerBody node={node as Extract<FlowNode, { type: 'trigger' }>} update={update} flowId={flowId} toolCatalog={toolCatalog} />
  ),
  requiredFields: ['trigger'],
}
