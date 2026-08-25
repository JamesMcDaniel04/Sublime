'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { advancedParamKeys, advancedParamsSetCount, type AdvancedParamKey } from '@/lib/flows/advanced-params'
import { AGENT_RUN_MAX_DURATION_SECONDS } from '@/lib/agents/timeouts'

const controlClass =
  'h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none transition-colors hover:border-muted-foreground/50 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'

/**
 * MS-parity "Advanced parameters" section: collapsed summary ("Showing N of
 * M"), Show all / Clear all, and the per-key controls declared by the
 * advanced-params manifest. Shared by the step card and the settings drawer.
 */
export function AdvancedParamsSection({
  node,
  onChange,
  defaultOpen = false,
}: {
  node: FlowNode
  onChange: (node: FlowNode) => void
  defaultOpen?: boolean
}) {
  const keys = advancedParamKeys(node.type)
  const [open, setOpen] = useState(defaultOpen)
  if (!keys.length) return null

  const data = node.data as Record<string, unknown>
  const setCount = advancedParamsSetCount(node)
  const patch = (values: Record<string, unknown>) => onChange({ ...node, data: { ...node.data, ...values } } as FlowNode)
  const clearAll = () => patch(Object.fromEntries(keys.map((key) => [key, undefined])))
  const maxTimeoutSeconds = node.type === 'agent' ? AGENT_RUN_MAX_DURATION_SECONDS : 120

  const control = (key: AdvancedParamKey) => {
    if (key === 'includeUpstream') {
      return (
        <select
          className={controlClass}
          value={data.includeUpstream === false ? 'false' : 'true'}
          onChange={(event) => patch({ includeUpstream: event.target.value === 'false' ? false : undefined })}
        >
          <option value="true">Auto-include upstream data</option>
          <option value="false">Use only this step&apos;s input</option>
        </select>
      )
    }
    if (key === 'excludeFromContext') {
      return (
        <select
          className={controlClass}
          value={data.excludeFromContext === true ? 'true' : 'false'}
          onChange={(event) => patch({ excludeFromContext: event.target.value === 'true' ? true : undefined })}
        >
          <option value="false">Included in agent context</option>
          <option value="true">Excluded from agent context</option>
        </select>
      )
    }
    if (key === 'forEachItem') {
      return (
        <select
          className={controlClass}
          value={data.forEachItem === true ? 'true' : 'false'}
          // undefined rather than false when off: advancedParamsSetCount
          // counts explicitly-set keys, so writing `false` would make an
          // untouched node report a tuned parameter.
          onChange={(event) => patch({ forEachItem: event.target.value === 'true' ? true : undefined })}
        >
          <option value="false">Run once for the whole list</option>
          <option value="true">Run once per item</option>
        </select>
      )
    }
    if (key === 'onError') {
      return (
        <select
          className={controlClass}
          value={(data.onError as string | undefined) ?? 'stop'}
          onChange={(event) => patch({ onError: event.target.value })}
        >
          <option value="stop">Stop flow on error</option>
          <option value="continue">Continue on error</option>
        </select>
      )
    }
    if (key === 'retries') {
      return (
        <input
          type="number"
          min={0}
          max={5}
          className={controlClass}
          value={(data.retries as number | undefined) ?? 0}
          onChange={(event) => patch({ retries: Math.max(0, Math.min(5, Number(event.target.value) || 0)) })}
        />
      )
    }
    if (key === 'timeoutMs') {
      const timeoutMs = data.timeoutMs as number | undefined
      return (
        <input
          type="number"
          min={1}
          max={maxTimeoutSeconds}
          className={controlClass}
          placeholder="No timeout"
          value={timeoutMs ? Math.round(timeoutMs / 1000) : ''}
          onChange={(event) => {
            const secs = Number(event.target.value)
            patch({ timeoutMs: secs > 0 ? Math.max(1, Math.min(maxTimeoutSeconds, secs)) * 1000 : undefined })
          }}
        />
      )
    }
    if (key === 'bodyMode') {
      return (
        <select className={controlClass} value={(data.bodyMode as string | undefined) ?? 'json'} onChange={(event) => patch({ bodyMode: event.target.value })}>
          <option value="json">JSON body</option>
          <option value="text">Text body</option>
          <option value="none">No body</option>
        </select>
      )
    }
    if (key === 'responseType') {
      return (
        <select className={controlClass} value={(data.responseType as string | undefined) ?? 'auto'} onChange={(event) => patch({ responseType: event.target.value })}>
          <option value="auto">Parse response automatically</option>
          <option value="json">Parse response as JSON</option>
          <option value="text">Parse response as text</option>
        </select>
      )
    }
    if (key === 'failOnHttpError') {
      return (
        <select
          className={controlClass}
          value={data.failOnHttpError === false ? 'false' : 'true'}
          onChange={(event) => patch({ failOnHttpError: event.target.value !== 'false' })}
        >
          <option value="true">Fail on 4xx/5xx</option>
          <option value="false">Return the response</option>
        </select>
      )
    }
    if (key === 'disabled' || key === 'followRedirects') {
      const active = data[key] === true
      return <select className={controlClass} value={active ? 'true' : 'false'} onChange={(event) => patch({ [key]: event.target.value === 'true' || undefined })}><option value="false">{key === 'disabled' ? 'Enabled' : 'Block redirects'}</option><option value="true">{key === 'disabled' ? 'Disabled' : 'Follow redirects safely'}</option></select>
    }
    if (key === 'queryArrayFormat') {
      return (
        <select
          className={controlClass}
          value={(data.queryArrayFormat as string | undefined) ?? 'repeat'}
          onChange={(event) => patch({ queryArrayFormat: event.target.value === 'repeat' ? undefined : event.target.value })}
        >
          <option value="repeat">Repeat key (tag=a&amp;tag=b)</option>
          <option value="brackets">Brackets (tag[]=a)</option>
          <option value="indices">Indices (tag[0]=a)</option>
          <option value="comma">Comma separated (tag=a,b)</option>
        </select>
      )
    }
    if (key === 'mockOutput') {
      return <textarea rows={3} className={cn(controlClass, 'h-auto min-h-20 py-2 font-mono text-xs')} value={data.mockOutput === undefined ? '' : JSON.stringify(data.mockOutput, null, 2)} placeholder="No mock output" onChange={(event) => { try { patch({ mockOutput: event.target.value.trim() ? JSON.parse(event.target.value) : undefined }) } catch { /* keep last valid value until JSON is valid */ } }} />
    }
    if (key === 'retryDelayMs' || key === 'maxRedirects') {
      return <input type="number" min={0} max={key === 'maxRedirects' ? 10 : 60000} className={controlClass} value={(data[key] as number | undefined) ?? ''} placeholder={key === 'maxRedirects' ? '3' : '500'} onChange={(event) => patch({ [key]: event.target.value === '' ? undefined : Number(event.target.value) })} />
    }
    // concurrency
    return (
      <input
        type="number"
        min={1}
        max={20}
        className={controlClass}
        value={(data.concurrency as number | undefined) ?? 3}
        onChange={(event) => patch({ concurrency: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })}
      />
    )
  }

  const LABELS: Record<AdvancedParamKey, string> = {
    includeUpstream: 'Upstream data',
    excludeFromContext: 'Agent context',
    forEachItem: 'Run for each item',
    onError: 'On error',
    retries: 'Retries',
    timeoutMs: 'Timeout (seconds)',
    bodyMode: 'Body type',
    responseType: 'Parse response as',
    failOnHttpError: 'HTTP errors',
    concurrency: 'At a time',
    disabled: 'Execution',
    mockOutput: 'Mock output (JSON)',
    retryDelayMs: 'Retry delay (ms)',
    followRedirects: 'Redirects',
    maxRedirects: 'Maximum redirects',
    queryArrayFormat: 'Array query params',
  }

  return (
    <div className="border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">Advanced parameters</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted"
          >
            {open ? 'Hide all' : `Showing ${setCount} of ${keys.length} — Show all`}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={setCount === 0}
            className="rounded-md px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {keys.map((key) => (
            <div key={key} className="grid gap-1.5">
              <label className={labelClass}>{LABELS[key]}</label>
              {control(key)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
