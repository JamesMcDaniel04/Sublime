'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Braces, Check, CircleStop, Clock, ClipboardCopy, Code2, Copy, Filter, GitBranch, Globe, LogIn, LogOut, MessageSquare, MoreHorizontal, PanelRight, Pencil, Plus, Radio, Repeat, Rows3, Settings2, ShieldAlert, SlidersHorizontal, Sparkles, Split, Trash2, UserCheck, Variable, Webhook, Workflow, Wrench, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { jamCursorColor } from '@/lib/flows/jam-presence'
import { type FlowNode } from '@/lib/flows/graph'
import { humanizeTokens, type TokenLabelContext } from '@/lib/flows/token-text'
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { stopEvent } from './nodes/field-primitives'
import { triggerData } from './nodes/trigger-body'
import { TypewriterStatus } from '@/components/ui/typewriter-status'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'waiting' | 'skipped' | 'stopped' | 'resumed'

// The full trigger shape the card edits inline (the old drawer's TriggerData):
// full trigger configuration inline without dropping fields on mutation.

/** Frequencies the schedule editor offers (matches AgentSchedule types). */

// Trigger cards show their subtype's icon (webhook/schedule/signal), matching
// the picker, so e.g. a webhook trigger reads distinctly from the HTTP action.
const TRIGGER_SUBTYPE_ICON: Record<string, typeof Bot> = {
  webhook: Webhook,
  schedule: Clock,
  signal: Radio,
  activity: Radio,
  manual: Zap,
  slack: MessageSquare,
}

// Labels for the Slack trigger's event-kind checkboxes, keyed off the
// client-safe SLACK_EVENT_KINDS list so the builder always matches the
// ingress/routing layer's supported event set.

const NODE_ICON: Record<FlowNode['type'], typeof Bot> = {
  trigger: Zap,
  agent: Bot,
  condition: GitBranch,
  loop: Repeat,
  parallel: Rows3,
  stop: CircleStop,
  tool: Wrench,
  http: Globe,
  code: Code2,
  respondWebhook: Webhook,
  wait: Clock,
  repeatUntil: Repeat,
  transform: SlidersHorizontal,
  filter: Filter,
  switch: Split,
  variable: Variable,
  data: Braces,
  humanReview: UserCheck,
  // input/output/subflow: no dedicated builder palette entry yet (follow-up UI
  // task); icons/tones are placeholders so the discriminated union stays total.
  input: LogIn,
  output: LogOut,
  subflow: Workflow,
  router: Sparkles,
  errorShield: ShieldAlert,
}

const NODE_TONE: Record<FlowNode['type'], string> = {
  trigger: 'bg-blue-600 text-white',
  agent: 'bg-foreground text-background',
  http: 'bg-emerald-600 text-white',
  code: 'bg-slate-700 text-white',
  respondWebhook: 'bg-emerald-700 text-white',
  wait: 'bg-sky-600 text-white',
  repeatUntil: 'bg-cyan-700 text-white',
  tool: 'bg-orange-500 text-white',
  condition: 'bg-amber-500 text-white',
  loop: 'bg-sky-500 text-white',
  parallel: 'bg-cyan-600 text-white',
  stop: 'bg-red-500 text-white',
  transform: 'bg-violet-500 text-white',
  filter: 'bg-lime-600 text-white',
  switch: 'bg-fuchsia-600 text-white',
  variable: 'bg-purple-600 text-white',
  data: 'bg-violet-600 text-white',
  humanReview: 'bg-blue-600 text-white',
  input: 'bg-teal-600 text-white',
  output: 'bg-rose-500 text-white',
  subflow: 'bg-foreground text-background',
  router: 'bg-fuchsia-500 text-white',
  errorShield: 'bg-rose-600 text-white',
}

const STATUS_DOT: Record<StepStatus, string> = {
  queued: 'bg-muted-foreground/40',
  running: 'bg-amber-400 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-blue-500 animate-pulse',
  skipped: 'bg-muted-foreground/40',
  stopped: 'bg-slate-500',
  resumed: 'bg-muted-foreground/40',
}








/** The one affordance a collapsed card may keep showing (MS parity). */
function collapsedAffordance(node: FlowNode): React.ReactNode | null {
  if (node.type !== 'trigger') return null
  const trigger = triggerData(node)
  if ((trigger.type ?? 'manual') !== 'manual') return null
  const count = triggerInputFieldsFromTrigger(trigger).length
  return (
    <span className="pointer-events-none flex items-center gap-3 py-2 text-base font-semibold text-muted-foreground">
      <Plus className="h-5 w-5" />
      {count > 0 ? `${count} input${count === 1 ? '' : 's'} — add another` : 'Add an input'}
    </span>
  )
}

// Sentinel for activeFieldRef: a non-token input (labels, field names, KV
// keys, …) is focused, so datatree inserts must be a no-op — falling back to

export function StepCard({
  node,
  index,
  title,
  subtitle,
  status,
  issues,
  selected,
  highlighted,
  labelCtx,
  onChange,
  onClick,
  onOpen,
  onDuplicate,
  onDelete,
  draggable,
  onDragStartNode,
  onDragEndNode,
  jamEditors,
}: {
  node: FlowNode
  index?: number
  title: string
  subtitle?: string
  status?: StepStatus
  issues?: { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }
  selected?: boolean
  highlighted?: boolean
  labelCtx?: TokenLabelContext
  onChange?: (node: FlowNode) => void
  /** Single click / Space: select on the canvas. */
  onClick?: () => void
  /** Double-click / Enter / "Open settings": open the Node Detail View. */
  onOpen?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  draggable?: boolean
  onDragStartNode?: (id: string) => void
  onDragEndNode?: () => void
  /** Flow Jam: teammates currently editing this node (presence). */
  jamEditors?: { userId: string; name: string }[]
}) {
  const triggerSubtype =
    node.type === 'trigger' ? String((node.data.trigger as { type?: string } | undefined)?.type ?? 'manual') : ''
  const Icon = node.type === 'trigger' ? (TRIGGER_SUBTYPE_ICON[triggerSubtype] ?? Zap) : NODE_ICON[node.type]
  // Read-only surfaces never show raw {{token}} syntax: humanize any node data
  // echoed in the collapsed summary or tooltips. Storage keeps canonical tokens.
  const humanize = (value: string) => (labelCtx ? humanizeTokens(value, labelCtx) : value)
  const displayTitle = humanize(title)
  const displaySubtitle = subtitle ? humanize(subtitle) : undefined
  const [renaming, setRenaming] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const isTrigger = node.type === 'trigger'
  const label = (node.data as { label?: string }).label ?? ''
  const setLabel = (value: string) => onChange?.({ ...node, data: { ...node.data, label: value || undefined } } as FlowNode)
  const copyNodeJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(node, null, 2))
      toast.success(isTrigger ? 'Trigger JSON copied.' : 'Step JSON copied.')
    } catch {
      toast.error('Could not copy to the clipboard.')
    }
  }
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    // Enter opens the Node Detail View; Space only selects. Mirrors the mouse
    // gestures (double-click opens, single click selects).
    if (event.key === 'Enter') (onOpen ?? onClick)?.()
    else onClick?.()
  }
  const issuesButtonRef = useRef<HTMLButtonElement | null>(null)
  const issuesPopoverRef = useRef<HTMLDivElement | null>(null)
  const [issuesPopover, setIssuesPopover] = useState<{ top: number; left: number } | null>(null)
  // Errors first so the most blocking problems lead the list.
  const issueItems = issues ? [...issues.items].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)) : []

  // Issues fixed while the popover is open: drop the popover with the badge.
  useEffect(() => {
    if (!issues || (issues.errors === 0 && issues.warnings === 0)) setIssuesPopover(null)
  }, [issues])

  useEffect(() => {
    if (!issuesPopover) return
    const close = () => setIssuesPopover(null)
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (issuesPopoverRef.current?.contains(target)) return
      if (issuesButtonRef.current?.contains(target)) return
      close()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
    }
  }, [issuesPopover])


  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onOpen?.()
      }}
      onKeyDown={onRootKeyDown}
      className={cn(
        'w-full rounded-[18px] border bg-card text-left shadow-[0_2px_10px_rgba(15,23,42,0.08)] outline-none transition-all duration-fast',
        'hover:border-border hover:shadow-[0_8px_24px_rgba(15,23,42,0.12)] focus-visible:ring-2 focus-visible:ring-blue-200',
        selected
          ? 'border-blue-500 ring-2 ring-blue-100'
          : highlighted
            ? 'border-indigo-400 ring-2 ring-indigo-200 animate-pulse'
            : issues?.errors
              ? 'border-red-400 ring-2 ring-red-100'
              : issues?.warnings
                ? 'border-amber-300'
                : 'border-border',
      )}
    >
      <div className="flex items-center gap-5 px-5 py-5">
        <span
          draggable={draggable}
          onDragStart={(event) => {
            event.dataTransfer.setData('text/flow-node-id', node.id)
            event.dataTransfer.effectAllowed = 'move'
            onDragStartNode?.(node.id)
          }}
          onDragEnd={() => onDragEndNode?.()}
          title="Drag to reorder"
          className={cn(
            'flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-lg',
            NODE_TONE[node.type],
            draggable && 'cursor-grab active:cursor-grabbing',
          )}
        >
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {typeof index === 'number' && <span className="text-xs font-semibold text-muted-foreground">{index}</span>}
            {renaming ? (
              <span className="flex items-center gap-1.5" onClick={stopEvent}>
                <input
                  autoFocus
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') setRenaming(false)
                  }}
                  onBlur={() => setRenaming(false)}
                  className="h-9 min-w-0 flex-1 rounded-md border border-blue-400 bg-background px-2 text-lg font-semibold text-foreground outline-none ring-2 ring-blue-100"
                  placeholder={displayTitle}
                  aria-label="Step name"
                />
                <button
                  type="button"
                  onClick={() => setRenaming(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                  aria-label="Done renaming"
                >
                  <Check className="h-4 w-4" />
                </button>
              </span>
            ) : (
              <h3 className="truncate text-lg font-semibold text-foreground">{displayTitle}</h3>
            )}
          </div>
          {displaySubtitle && <p className="mt-0.5 truncate text-sm text-muted-foreground">{displaySubtitle}</p>}
        </div>
        {issues && (issues.errors > 0 || issues.warnings > 0) && (
          <button
            ref={issuesButtonRef}
            type="button"
            aria-label="Show issues"
            aria-expanded={Boolean(issuesPopover)}
            onClick={(event) => {
              event.stopPropagation()
              if (issuesPopover) {
                setIssuesPopover(null)
                return
              }
              const rect = event.currentTarget.getBoundingClientRect()
              setIssuesPopover({
                top: rect.bottom + 6,
                left: Math.min(rect.left, window.innerWidth - 336),
              })
            }}
            className={cn(
              'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white',
              issues.errors > 0 ? 'bg-red-500' : 'bg-amber-500',
            )}
          >
            {issues.errors + issues.warnings}
          </button>
        )}
        {jamEditors && jamEditors.length > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] font-semibold"
            // The peer's stable cursor color, so "who is here" matches their
            // cursor and canvas outline everywhere.
            style={{ borderColor: jamCursorColor(jamEditors[0].userId), color: jamCursorColor(jamEditors[0].userId) }}
            title={`${jamEditors.map((editor) => editor.name).join(', ')} editing`}
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: jamCursorColor(jamEditors[0].userId) }} />
            {jamEditors.length === 1 ? `${jamEditors[0].name} is here` : `${jamEditors.length} teammates here`}
          </span>
        )}
        {status && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-semibold text-muted-foreground">
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
            {status === 'running' ? <TypewriterStatus seed={node.id.length ? node.id.charCodeAt(node.id.length - 1) : 0} /> : status}
          </span>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            ;(onOpen ?? onClick)?.()
          }}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:flex"
          aria-label="Open step settings"
          title="Open step settings"
        >
          <PanelRight className="h-5 w-5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Step options"
              title="Step options"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            {!isTrigger && onDelete && (
              <>
                <DropdownMenuItem onSelect={onDelete} className="text-red-600 focus:text-red-700">
                  <Trash2 className="h-4 w-4" /> Delete
                  <span className="ml-auto pl-4 text-xs text-muted-foreground">Del</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={copyNodeJson}>
              <ClipboardCopy className="h-4 w-4" /> {isTrigger ? 'Copy trigger JSON' : 'Copy step JSON'}
              <span className="ml-auto pl-4 text-xs text-muted-foreground">⌘C</span>
            </DropdownMenuItem>
            {!isTrigger && (
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <Pencil className="h-4 w-4" /> Rename
              </DropdownMenuItem>
            )}
            {!isTrigger && onDuplicate && (
              <DropdownMenuItem onSelect={onDuplicate}>
                <Copy className="h-4 w-4" /> Duplicate
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => (onOpen ?? onClick)?.()}>
              <Settings2 className="h-4 w-4" /> Open settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCodeOpen(true)}>
              <Code2 className="h-4 w-4" /> Code view
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {collapsedAffordance(node) && (
        <div className="border-t border-border px-5 py-1.5">{collapsedAffordance(node)}</div>
      )}
      {codeOpen && (
        <div onClick={stopEvent} className="border-t border-border px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code view</p>
            <div className="flex items-center gap-3">
              <button type="button" onClick={copyNodeJson} className="text-xs font-semibold text-blue-700 hover:text-blue-900">
                Copy
              </button>
              <button type="button" onClick={() => setCodeOpen(false)} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
                Close
              </button>
            </div>
          </div>
          <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100">{JSON.stringify(node, null, 2)}</pre>
        </div>
      )}
      {issuesPopover && issueItems.length > 0 &&
        createPortal(
          <div
            ref={issuesPopoverRef}
            style={{ position: 'fixed', top: issuesPopover.top, left: issuesPopover.left, zIndex: 60 }}
            className="w-max max-w-xs rounded-xl border border-border bg-card p-3 shadow-[0_16px_48px_rgba(15,23,42,0.18)]"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <ul className="space-y-2">
              {issueItems.map((item, itemIndex) => (
                <li key={itemIndex} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', item.level === 'error' ? 'bg-red-500' : 'bg-amber-500')} />
                  <span className="min-w-0">{humanize(item.message)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-border pt-2">
              <button
                type="button"
                onClick={() => {
                  setIssuesPopover(null)
                  onClick?.()
                }}
                className="text-xs font-semibold text-blue-700 hover:text-blue-900"
              >
                Fix in settings
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
