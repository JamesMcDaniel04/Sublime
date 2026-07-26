'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { controlClass, labelClass } from './field-primitives'
import type { TokenEditorWiring } from './types'

type HttpNode = Extract<FlowNode, { type: 'http' }>
type Data = Record<string, unknown>
type Patch = (values: Data) => void

/**
 * n8n's "Options / Add option" panel for the HTTP node.
 *
 * REPLACES the MS-style "Advanced parameters — Showing N of M" section, which
 * had two problems beyond looking wrong:
 *
 *   1. It carried its own `bodyMode` select offering json/text/none, while the
 *      Send Body section offers json/raw/graphql/formUrlencoded. Picking
 *      GraphQL above left that select rendering blank, and touching it silently
 *      rewrote bodyMode to `json`, discarding the query and variables. Body
 *      Content Type is now the single owner of that field.
 *   2. Four options the executor fully implements — pagination, batching,
 *      retry-on-status, and cookie — had no control anywhere, so they were
 *      reachable only by editing the flow JSON.
 *
 * An option is "added" when its value is not undefined; removing one clears it
 * back to undefined so the executor falls through to its own default.
 */

type OptionKey =
  | 'responseType' | 'failOnHttpError' | 'followRedirects' | 'maxRedirects' | 'timeoutMs'
  | 'retries' | 'retryDelayMs' | 'retryStatusCodes' | 'queryArrayFormat' | 'cookie'
  | 'pagination' | 'batch' | 'onError' | 'excludeFromContext' | 'disabled' | 'mockOutput'

const LABELS: Record<OptionKey, string> = {
  responseType: 'Response format',
  failOnHttpError: 'HTTP errors',
  followRedirects: 'Redirects',
  maxRedirects: 'Max redirects',
  timeoutMs: 'Timeout (seconds)',
  retries: 'Retry on fail',
  retryDelayMs: 'Retry delay (ms)',
  retryStatusCodes: 'Retry on status codes',
  queryArrayFormat: 'Array format in query parameters',
  cookie: 'Cookie',
  pagination: 'Pagination',
  batch: 'Batching',
  onError: 'On error',
  excludeFromContext: 'Agent context',
  disabled: 'Execution',
  mockOutput: 'Mock output (JSON)',
}

/** Value written when an option is first added — its documented default. */
const DEFAULTS: Record<OptionKey, unknown> = {
  responseType: 'auto',
  failOnHttpError: true,
  followRedirects: true,
  maxRedirects: 3,
  timeoutMs: 30_000,
  retries: 1,
  retryDelayMs: 500,
  retryStatusCodes: [429, 502, 503, 504],
  queryArrayFormat: 'repeat',
  cookie: '',
  pagination: { mode: 'page', pageParam: 'page', startPage: 1, maxPages: 10 },
  batch: { size: 10, delayMs: 1000 },
  onError: 'stop',
  excludeFromContext: true,
  disabled: true,
  mockOutput: {},
}

const ORDER: OptionKey[] = [
  'pagination', 'batch', 'responseType', 'failOnHttpError', 'timeoutMs',
  'retries', 'retryDelayMs', 'retryStatusCodes', 'followRedirects', 'maxRedirects',
  'queryArrayFormat', 'cookie', 'onError', 'excludeFromContext', 'disabled', 'mockOutput',
]

const numberOr = (value: string, fallback: number) => (value === '' ? fallback : Number(value))

function SelectOption({
  value, onChange, options, ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<[string, string]>
  ariaLabel: string
}) {
  return (
    <select aria-label={ariaLabel} className={controlClass} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
    </select>
  )
}

function PaginationOption({ value, patch }: { value: Data; patch: Patch }) {
  const set = (values: Data) => patch({ pagination: { ...value, ...values } })
  const mode = String(value.mode ?? 'page')
  return (
    <div className="grid gap-2">
      <SelectOption
        ariaLabel="Pagination mode"
        value={mode}
        onChange={(next) => set({ mode: next })}
        options={[
          ['page', 'Page parameter (?page=1, 2, 3…)'],
          ['cursor', 'Cursor from the response'],
          ['nextUrl', 'Follow a next-page URL in the response'],
          ['off', 'Off'],
        ]}
      />
      {mode === 'page' && (
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Page parameter" className={controlClass} placeholder="page"
            value={String(value.pageParam ?? '')} onChange={(event) => set({ pageParam: event.target.value || undefined })} />
          <input aria-label="First page number" type="number" min={0} className={controlClass} placeholder="1"
            value={String(value.startPage ?? '')} onChange={(event) => set({ startPage: event.target.value === '' ? undefined : Number(event.target.value) })} />
        </div>
      )}
      {mode === 'cursor' && (
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Cursor parameter" className={controlClass} placeholder="cursor"
            value={String(value.cursorParam ?? '')} onChange={(event) => set({ cursorParam: event.target.value || undefined })} />
          <input aria-label="Cursor path in response" className={controlClass} placeholder="nextCursor"
            value={String(value.cursorPath ?? '')} onChange={(event) => set({ cursorPath: event.target.value || undefined })} />
        </div>
      )}
      {mode === 'nextUrl' && (
        <input aria-label="Next URL path in response" className={controlClass} placeholder="next"
          value={String(value.nextUrlPath ?? '')} onChange={(event) => set({ nextUrlPath: event.target.value || undefined })} />
      )}
      <div className="grid grid-cols-2 gap-2">
        <input aria-label="Maximum pages" type="number" min={1} max={1000} className={controlClass} placeholder="Max pages (10)"
          value={String(value.maxPages ?? '')} onChange={(event) => set({ maxPages: event.target.value === '' ? undefined : Number(event.target.value) })} />
        <input aria-label="Pause between pages (ms)" type="number" min={0} max={60000} className={controlClass} placeholder="Pause between pages (ms)"
          value={String(value.intervalMs ?? '')} onChange={(event) => set({ intervalMs: event.target.value === '' ? undefined : Number(event.target.value) })} />
      </div>
      <input aria-label="Stop when this response path is truthy" className={controlClass} placeholder="Stop when truthy, e.g. meta.isLastPage"
        value={String(value.stopPath ?? '')} onChange={(event) => set({ stopPath: event.target.value || undefined })} />
      <p className="text-[11px] leading-4 text-muted-foreground">
        The step returns every page as a list. Pausing between pages keeps a rate-limited API happy.
      </p>
    </div>
  )
}

function BatchOption({ value, patch }: { value: Data; patch: Patch }) {
  const set = (values: Data) => patch({ batch: { ...value, ...values } })
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        <input aria-label="Requests per batch" type="number" min={1} max={1000} className={controlClass} placeholder="Requests per batch"
          value={String(value.size ?? '')} onChange={(event) => set({ size: numberOr(event.target.value, 1) })} />
        <input aria-label="Pause between batches (ms)" type="number" min={0} max={60000} className={controlClass} placeholder="Pause (ms)"
          value={String(value.delayMs ?? '')} onChange={(event) => set({ delayMs: event.target.value === '' ? undefined : Number(event.target.value) })} />
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">
        Pause after every N requests while paginating.
      </p>
    </div>
  )
}

function StatusCodesOption({ value, patch }: { value: unknown; patch: Patch }) {
  const list = Array.isArray(value) ? value : []
  return (
    <div className="grid gap-1.5">
      <input
        aria-label="Retry on status codes"
        className={controlClass}
        placeholder="429, 502, 503, 504"
        value={list.join(', ')}
        onChange={(event) => patch({
          retryStatusCodes: event.target.value
            .split(',')
            .map((code) => Number(code.trim()))
            .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599),
        })}
      />
      <p className="text-[11px] leading-4 text-muted-foreground">
        These responses are treated as failures so the retry policy above applies to them.
      </p>
    </div>
  )
}

export function HttpOptionsSection({
  node,
  onChange,
}: {
  node: HttpNode
  onChange: (node: FlowNode) => void
  /** Accepted for call-site symmetry with the other node sections. */
  tokenWiring?: TokenEditorWiring
}) {
  const [adding, setAdding] = useState('')
  const data = node.data as Data
  const patch: Patch = (values) => onChange({ ...node, data: { ...node.data, ...values } } as FlowNode)

  const added = ORDER.filter((key) => data[key] !== undefined)
  const available = ORDER.filter((key) => data[key] === undefined)

  const control = (key: OptionKey) => {
    const value = data[key]
    if (key === 'pagination') return <PaginationOption value={(value ?? {}) as Data} patch={patch} />
    if (key === 'batch') return <BatchOption value={(value ?? {}) as Data} patch={patch} />
    if (key === 'retryStatusCodes') return <StatusCodesOption value={value} patch={patch} />
    if (key === 'mockOutput') {
      return (
        <textarea
          aria-label="Mock output JSON"
          rows={3}
          className={cn(controlClass, 'h-auto min-h-20 py-2 font-mono text-xs')}
          defaultValue={JSON.stringify(value, null, 2)}
          onChange={(event) => {
            // Keep the last valid value while the user is mid-edit; an
            // uncontrolled textarea avoids fighting their keystrokes.
            try { patch({ mockOutput: event.target.value.trim() ? JSON.parse(event.target.value) : {} }) } catch { /* not valid JSON yet */ }
          }}
        />
      )
    }
    if (key === 'cookie') {
      return (
        <input aria-label="Cookie" className={controlClass} placeholder="session=abc; theme=dark"
          value={String(value ?? '')} onChange={(event) => patch({ cookie: event.target.value })} />
      )
    }
    if (key === 'timeoutMs') {
      const seconds = Math.round(Number(value) / 1000)
      return (
        <input aria-label="Timeout (seconds)" type="number" min={1} max={120} className={controlClass}
          value={Number.isFinite(seconds) ? seconds : 30}
          onChange={(event) => patch({ timeoutMs: Math.max(1, Math.min(120, numberOr(event.target.value, 30))) * 1000 })} />
      )
    }
    if (key === 'retries' || key === 'retryDelayMs' || key === 'maxRedirects') {
      const max = key === 'retries' ? 5 : key === 'maxRedirects' ? 10 : 60_000
      return (
        <input aria-label={LABELS[key]} type="number" min={0} max={max} className={controlClass}
          value={String(value ?? '')}
          onChange={(event) => patch({ [key]: Math.max(0, Math.min(max, numberOr(event.target.value, 0))) })} />
      )
    }
    const booleanOptions: Partial<Record<OptionKey, Array<[string, string]>>> = {
      failOnHttpError: [['true', 'Fail the step on 4xx/5xx'], ['false', 'Return the response instead']],
      followRedirects: [['true', 'Follow redirects'], ['false', 'Block redirects']],
      excludeFromContext: [['true', 'Excluded from agent context'], ['false', 'Included in agent context']],
      disabled: [['true', 'Disabled'], ['false', 'Enabled']],
    }
    const options = booleanOptions[key]
    if (options) {
      return (
        <SelectOption ariaLabel={LABELS[key]} value={value === true ? 'true' : 'false'}
          onChange={(next) => patch({ [key]: next === 'true' })} options={options} />
      )
    }
    if (key === 'responseType') {
      return (
        <SelectOption ariaLabel={LABELS[key]} value={String(value ?? 'auto')} onChange={(next) => patch({ responseType: next })}
          options={[['auto', 'Automatic'], ['json', 'JSON'], ['text', 'Text'], ['binary', 'Binary (base64)']]} />
      )
    }
    if (key === 'onError') {
      return (
        <SelectOption ariaLabel={LABELS[key]} value={String(value ?? 'stop')} onChange={(next) => patch({ onError: next })}
          options={[['stop', 'Stop the flow'], ['continue', 'Continue to the next step']]} />
      )
    }
    return (
      <SelectOption ariaLabel={LABELS[key]} value={String(value ?? 'repeat')} onChange={(next) => patch({ queryArrayFormat: next })}
        options={[
          ['repeat', 'Repeat key (tag=a&tag=b)'],
          ['brackets', 'Brackets (tag[]=a)'],
          ['indices', 'Indices (tag[0]=a)'],
          ['comma', 'Comma separated (tag=a,b)'],
        ]} />
    )
  }

  return (
    <section className="grid gap-3 border-t border-border pt-4">
      <p className="text-sm font-semibold text-foreground">Options</p>

      {added.length === 0 ? (
        <p className="text-xs text-muted-foreground">No properties</p>
      ) : (
        <div className="grid gap-3">
          {added.map((key) => (
            <div key={key} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className={labelClass}>{LABELS[key]}</label>
                <button
                  type="button"
                  aria-label={`Remove ${LABELS[key]}`}
                  onClick={() => patch({ [key]: undefined })}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {control(key)}
            </div>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <select
          aria-label="Add option"
          className={cn(controlClass, 'text-muted-foreground')}
          value={adding}
          onChange={(event) => {
            const key = event.target.value as OptionKey
            if (key) patch({ [key]: DEFAULTS[key] })
            setAdding('')
          }}
        >
          <option value="">Add option</option>
          {available.map((key) => <option key={key} value={key}>{LABELS[key]}</option>)}
        </select>
      )}
    </section>
  )
}
