'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import {
  Bot,
  Braces,
  CalendarDays,
  Check,
  CircleStop,
  Clock,
  ClipboardCopy,
  Code2,
  Copy,
  FileText,
  Filter,
  GitBranch,
  Globe,
  Hash,
  Link2,
  LogIn,
  LogOut,
  Mail,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Repeat,
  Rows3,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Split,
  ToggleLeft,
  Trash2,
  Type,
  UserCheck,
  Variable,
  Webhook,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { cn } from '@/lib/utils'
import { jamCursorColor } from '@/lib/flows/jam-presence'
import { CONDITION_OPS, CONDITION_OP_LABELS, DATA_OPS, FIELD_TYPES, VARIABLE_OPS, VARIABLE_OP_LABELS, VARIABLE_TYPES, VARIABLE_TYPE_LABELS, type ConditionClause, type ConditionOp, type DataOp, type FlowNode, type OutputField, type TriggerInputField, type VariableOp, type VariableType } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { DATA_OP_HELPER, DATA_OP_INPUT_PLACEHOLDER, VARIABLE_VALUE_PLACEHOLDER, variableValueOptional } from '@/lib/flows/step-copy'
import { humanizeTokens, type TokenLabelContext } from '@/lib/flows/token-text'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { KNOWN_SIGNALS, triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { SLACK_EVENT_KINDS, type SlackEventKind } from '@/lib/slack/payload'
import { nextOccurrence, type AgentSchedule } from '@/lib/scheduling/due'
import { Button } from '@/components/ui/button'
import { TriggerFilterEditor } from './trigger-filter-editor'
import type { ToolCatalog } from './tool-catalog-type'
import { ToolArgsEditor } from './tool-args-editor'
import { NODE_TYPES, type EditableType } from './node-types'
import { AdvancedParamsSection } from './advanced-params'
import { DataTree } from './data-tree'
import { TokenTextEditor, type TokenTextEditorHandle } from './token-text-editor'
import type { DataField } from '@/lib/flows/datatree'
import { TypewriterStatus } from '@/components/ui/typewriter-status'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'waiting' | 'skipped' | 'stopped' | 'resumed'

type Agent = { id: string; title: string }
// The full trigger shape the card edits inline (the old drawer's TriggerData):
// full trigger configuration inline without dropping fields on mutation.
type TriggerData = {
  type?: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack' | 'activity'
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
}

/** Frequencies the schedule editor offers (matches AgentSchedule types). */
const FREQUENCIES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Cron expression' },
  { value: 'once', label: 'Once' },
] as const
type KeyValueRow = { key: string; value: string }
type InputKind = 'text' | 'yesno' | 'file' | 'email' | 'number' | 'date'

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
const SLACK_EVENT_LABELS: Record<SlackEventKind, string> = {
  app_mention: '@mentions of the bot',
  'message.im': 'Direct messages',
  'message.channels': 'Channel messages',
  slash_command: 'A slash command',
}

const NODE_ICON: Record<FlowNode['type'], typeof Bot> = {
  trigger: Zap,
  agent: Bot,
  condition: GitBranch,
  loop: Repeat,
  parallel: Rows3,
  stop: CircleStop,
  tool: Wrench,
  http: Globe,
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
  agent: 'bg-slate-900 text-white',
  http: 'bg-emerald-600 text-white',
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
  subflow: 'bg-indigo-600 text-white',
  router: 'bg-fuchsia-500 text-white',
  errorShield: 'bg-rose-600 text-white',
}

const STATUS_DOT: Record<StepStatus, string> = {
  queued: 'bg-gray-300',
  running: 'bg-amber-400 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-blue-500 animate-pulse',
  skipped: 'bg-gray-300',
  stopped: 'bg-slate-500',
  resumed: 'bg-gray-300',
}

const INPUT_TYPES: {
  id: InputKind
  label: string
  description: string
  name: string
  fieldType: OutputField['type']
  icon: typeof Type
  tone: string
}[] = [
  { id: 'text', label: 'Text', description: 'Please enter your input', name: 'text', fieldType: 'string', icon: Type, tone: 'bg-purple-500 text-white' },
  { id: 'yesno', label: 'Yes / No', description: 'Choose yes or no.', name: 'yesNo', fieldType: 'boolean', icon: ToggleLeft, tone: 'bg-indigo-500 text-white' },
  { id: 'file', label: 'File', description: 'Upload or provide file data.', name: 'file', fieldType: 'object', icon: FileText, tone: 'bg-slate-700 text-white' },
  { id: 'email', label: 'Email', description: 'Enter an email address.', name: 'email', fieldType: 'string', icon: Mail, tone: 'bg-green-600 text-white' },
  { id: 'number', label: 'Number', description: 'Enter a number.', name: 'number', fieldType: 'number', icon: Hash, tone: 'bg-orange-500 text-white' },
  { id: 'date', label: 'Date', description: 'Enter a date.', name: 'date', fieldType: 'string', icon: CalendarDays, tone: 'bg-rose-500 text-white' },
]

const controlClass =
  'h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
// TokenTextEditor overrides that restyle the drawer-flavored defaults to match
// the card's denser slate inputs. No border color here — `invalid` red borders
// (appended after this string) must win in tailwind-merge order.
const tokenControlBase =
  'min-h-10 rounded-md bg-white px-3 py-2 text-sm text-slate-950 transition-colors empty:before:text-slate-400 hover:border-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
const tokenControlClass = `${tokenControlBase} border-slate-300`
const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function triggerData(node: Extract<FlowNode, { type: 'trigger' }>): TriggerData {
  return isRecord(node.data.trigger) ? (node.data.trigger as TriggerData) : { type: 'manual' }
}

function inputTypeForField(field: OutputField) {
  const text = `${field.name} ${field.description ?? ''}`.toLowerCase()
  if (field.type === 'boolean') return INPUT_TYPES.find((type) => type.id === 'yesno')!
  if (field.type === 'number') return INPUT_TYPES.find((type) => type.id === 'number')!
  if (text.includes('email')) return INPUT_TYPES.find((type) => type.id === 'email')!
  if (text.includes('date')) return INPUT_TYPES.find((type) => type.id === 'date')!
  if (field.type === 'object' || field.type === 'array' || text.includes('file')) return INPUT_TYPES.find((type) => type.id === 'file')!
  return INPUT_TYPES.find((type) => type.id === 'text')!
}

function uniqueFieldName(base: string, fields: OutputField[]): string {
  const names = new Set(fields.map((field) => field.name))
  if (!names.has(base)) return base
  let index = 2
  while (names.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}

function parseKeyValueRows(value?: string): KeyValueRow[] {
  if (!value?.trim()) return [{ key: '', value: '' }]
  try {
    const parsed = JSON.parse(value)
    if (isRecord(parsed)) {
      const rows = Object.entries(parsed).map(([key, raw]) => ({
        key,
        value: typeof raw === 'string' ? raw : JSON.stringify(raw),
      }))
      return rows.length ? rows : [{ key: '', value: '' }]
    }
  } catch {
    return [{ key: '', value }]
  }
  return [{ key: '', value }]
}

function serializeKeyValueRows(rows: KeyValueRow[]): string {
  const entries = rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value] as const)
  if (!entries.length) return ''
  return JSON.stringify(Object.fromEntries(entries), null, 2)
}

function defaultAgentInput(value?: string): boolean {
  const trimmed = (value ?? '').trim()
  return trimmed === 'Use this flow input:\n{{trigger.input}}' || trimmed === 'Process this item:\n{{item}}'
}

function firstClause(node: Extract<FlowNode, { type: 'condition' | 'filter' }>): ConditionClause {
  if (node.data.clauses?.[0]) return node.data.clauses[0]
  if (node.type === 'condition') {
    return { left: node.data.left ?? '', op: node.data.op ?? 'contains', right: node.data.right ?? '' }
  }
  return { left: '', op: 'contains', right: '' }
}

function transformFields(node: Extract<FlowNode, { type: 'transform' }>): { name: string; value: string }[] {
  return node.data.fields.length ? node.data.fields : [{ name: '', value: '' }]
}

function switchFirstCase(node: Extract<FlowNode, { type: 'switch' }>) {
  return node.data.cases[0] ?? { id: 'case1', left: '', op: 'contains' as ConditionOp, right: '' }
}

function routerFirstBranch(node: Extract<FlowNode, { type: 'router' }>) {
  return node.data.branches[0] ?? { id: 'branch1', label: '' }
}

function selectedTool(connectionId: string, toolName: string, toolCatalog: ToolCatalog) {
  const connection = toolCatalog.find((entry) => entry.id === connectionId)
  const tool = connection?.tools.find((entry) => entry.name === toolName)
  return { connection, tool }
}

function stopEvent(event: React.MouseEvent | React.FocusEvent) {
  event.stopPropagation()
}

/** The one affordance a collapsed card may keep showing (MS parity). */
function collapsedAffordance(node: FlowNode): React.ReactNode | null {
  if (node.type !== 'trigger') return null
  const trigger = triggerData(node)
  if ((trigger.type ?? 'manual') !== 'manual') return null
  const count = triggerInputFieldsFromTrigger(trigger).length
  return (
    <span className="pointer-events-none flex items-center gap-3 py-2 text-base font-semibold text-slate-700">
      <Plus className="h-5 w-5" />
      {count > 0 ? `${count} input${count === 1 ? '' : 's'} — add another` : 'Add an input'}
    </span>
  )
}

// Sentinel for activeFieldRef: a non-token input (labels, field names, KV
// keys, …) is focused, so datatree inserts must be a no-op — falling back to
// the step's primary field would silently write to a field the user is not
// editing.
const NON_TOKEN_FOCUSED = 'non-token-focused'

// Where a datatree click lands when no chip editor has been focused yet: the
// step type's primary token field.
const DEFAULT_EDITOR_KEYS: Partial<Record<FlowNode['type'], string>> = {
  agent: 'agent.input',
  http: 'http.body',
  loop: 'loop.over',
  transform: 'xf.0',
  condition: 'clause.left',
  filter: 'clause.left',
  switch: 'sw.left',
  variable: 'var.value',
  data: 'data.input',
  humanReview: 'hr.message',
}

// Chip editors still render when the caller omitted labelCtx: chips fall back
// to generic step labels instead of crashing.
const EMPTY_LABEL_CTX: TokenLabelContext = { stepLabels: {} }

type TokenEditorWiring = {
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  blockActive: () => void
  unblockActive: () => void
}

export function StepCard({
  node,
  flowId,
  index,
  title,
  subtitle,
  status,
  issues,
  selected,
  highlighted,
  agents,
  toolCatalog,
  dataFields,
  labelCtx,
  variableNames,
  onChange,
  onClick,
  onRefreshAgents,
  onDuplicate,
  onDelete,
  draggable,
  onDragStartNode,
  onDragEndNode,
  onChangeType,
  onAddStep,
  jamEditors,
}: {
  node: FlowNode
  /** Needed by the trigger card's webhook panel to mint a trigger secret. */
  flowId?: string
  index?: number
  title: string
  subtitle?: string
  status?: StepStatus
  issues?: { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }
  selected?: boolean
  highlighted?: boolean
  agents: Agent[]
  toolCatalog: ToolCatalog
  dataFields?: DataField[]
  labelCtx?: TokenLabelContext
  variableNames?: string[]
  onChange?: (node: FlowNode) => void
  onClick?: () => void
  onRefreshAgents?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  draggable?: boolean
  onDragStartNode?: (id: string) => void
  onDragEndNode?: () => void
  onChangeType?: (type: EditableType) => void
  onAddStep?: (type: EditableType, branchIndex?: number) => void
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
  const update = (updated: FlowNode) => onChange?.(updated)
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
    onClick?.()
  }
  // Chip-editor handles keyed by field, so a datatree click inserts a token
  // chip at the caret of the last-focused editor.
  const editorHandles = useRef<Map<string, TokenTextEditorHandle | null>>(new Map())
  const editorRefCallbacks = useRef<Map<string, (handle: TokenTextEditorHandle | null) => void>>(new Map())
  const activeFieldRef = useRef<string | null>(null)
  const activeEditorElRef = useRef<HTMLElement | null>(null)
  const tokenPopoverRef = useRef<HTMLDivElement | null>(null)
  const [tokenPopover, setTokenPopover] = useState<{ top: number; left: number; width: number } | null>(null)
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
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null
    activeEditorElRef.current = el
    if (selected && dataFields && dataFields.length > 0 && el) {
      // getBoundingClientRect() already returns post-transform (zoomed) coordinates, so the
      // popover lines up with the field regardless of the canvas zoom level — no scale compensation needed.
      const rect = el.getBoundingClientRect()
      setTokenPopover({
        top: rect.bottom + 6,
        left: Math.min(rect.left, window.innerWidth - 380),
        width: Math.max(320, Math.min(rect.width, 420)),
      })
    }
  }
  // While any non-token input is focused, datatree inserts are blocked
  // entirely; blur restores the normal fallback behavior.
  const blockActive = () => {
    activeFieldRef.current = NON_TOKEN_FOCUSED
  }
  const unblockActive = () => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) activeFieldRef.current = null
  }
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
  const tokenWiring: TokenEditorWiring = {
    labelCtx: labelCtx ?? EMPTY_LABEL_CTX,
    registerEditor,
    focusEditor,
    blockActive,
    unblockActive,
  }
  const showErrors = Boolean(issues?.errors)
  const issuesButtonRef = useRef<HTMLButtonElement | null>(null)
  const issuesPopoverRef = useRef<HTMLDivElement | null>(null)
  const [issuesPopover, setIssuesPopover] = useState<{ top: number; left: number } | null>(null)
  // Errors first so the most blocking problems lead the list.
  const issueItems = issues ? [...issues.items].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)) : []

  useEffect(() => {
    if (!selected) {
      setTokenPopover(null)
      activeFieldRef.current = null
      activeEditorElRef.current = null
    }
  }, [selected])

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

  useEffect(() => {
    if (!tokenPopover) return
    const close = () => setTokenPopover(null)
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (tokenPopoverRef.current?.contains(target)) return
      if (activeEditorElRef.current?.contains(target)) return
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
  }, [tokenPopover])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
      onKeyDown={onRootKeyDown}
      className={cn(
        'w-full rounded-[18px] border bg-white text-left shadow-[0_2px_10px_rgba(15,23,42,0.08)] outline-none transition-all duration-fast',
        'hover:border-slate-300 hover:shadow-[0_8px_24px_rgba(15,23,42,0.12)] focus-visible:ring-2 focus-visible:ring-blue-200',
        selected
          ? 'border-blue-500 ring-2 ring-blue-100'
          : highlighted
            ? 'border-indigo-400 ring-2 ring-indigo-200 animate-pulse'
            : issues?.errors
              ? 'border-red-400 ring-2 ring-red-100'
              : issues?.warnings
                ? 'border-amber-300'
                : 'border-slate-200',
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
            {typeof index === 'number' && <span className="text-xs font-semibold text-slate-400">{index}</span>}
            {renaming ? (
              <span className="flex items-center gap-1.5" onClick={stopEvent}>
                <input
                  autoFocus
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') setRenaming(false)
                  }}
                  onFocus={blockActive}
                  onBlur={() => {
                    unblockActive()
                    setRenaming(false)
                  }}
                  className="h-9 min-w-0 flex-1 rounded-md border border-blue-400 bg-white px-2 text-lg font-semibold text-slate-950 outline-none ring-2 ring-blue-100"
                  placeholder={displayTitle}
                  aria-label="Step name"
                />
                <button
                  type="button"
                  onClick={() => setRenaming(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                  aria-label="Done renaming"
                >
                  <Check className="h-4 w-4" />
                </button>
              </span>
            ) : (
              <h3 className="truncate text-lg font-semibold text-slate-950">{displayTitle}</h3>
            )}
          </div>
          {displaySubtitle && <p className="mt-0.5 truncate text-sm text-slate-500">{displaySubtitle}</p>}
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
            className="flex shrink-0 items-center gap-1 rounded-full border bg-white px-2 py-0.5 text-[11px] font-semibold"
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
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
            {status === 'running' ? <TypewriterStatus seed={node.id.length ? node.id.charCodeAt(node.id.length - 1) : 0} /> : status}
          </span>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onClick?.()
          }}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 sm:flex"
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
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
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
                  <span className="ml-auto pl-4 text-xs text-slate-400">Del</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={copyNodeJson}>
              <ClipboardCopy className="h-4 w-4" /> {isTrigger ? 'Copy trigger JSON' : 'Copy step JSON'}
              <span className="ml-auto pl-4 text-xs text-slate-400">⌘C</span>
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
            <DropdownMenuItem onSelect={() => onClick?.()}>
              <Settings2 className="h-4 w-4" /> Open settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCodeOpen(true)}>
              <Code2 className="h-4 w-4" /> Code view
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AnimatePresence initial={false}>
        {selected ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div onClick={stopEvent} onFocus={stopEvent} className="border-t border-slate-200 px-5 py-4">
              {renderNodeBody({ node, flowId, agents, toolCatalog, update, onRefreshAgents, tokenWiring, showErrors, variableNames, dataFields, onAddStep })}
              {node.type !== 'trigger' && (
                <StepSettingsFooter node={node} update={update} onChangeType={onChangeType} tokenWiring={tokenWiring} />
              )}
            </div>
          </motion.div>
        ) : (
          collapsedAffordance(node) && (
            <div className="border-t border-slate-200 px-5 py-1.5">{collapsedAffordance(node)}</div>
          )
        )}
      </AnimatePresence>
      {codeOpen && (
        <div onClick={stopEvent} className="border-t border-slate-200 px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Code view</p>
            <div className="flex items-center gap-3">
              <button type="button" onClick={copyNodeJson} className="text-xs font-semibold text-blue-700 hover:text-blue-900">
                Copy
              </button>
              <button type="button" onClick={() => setCodeOpen(false)} className="text-xs font-semibold text-slate-500 hover:text-slate-900">
                Close
              </button>
            </div>
          </div>
          <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100">{JSON.stringify(node, null, 2)}</pre>
        </div>
      )}
      {selected && tokenPopover && dataFields && dataFields.length > 0 &&
        createPortal(
          <div
            ref={tokenPopoverRef}
            style={{ position: 'fixed', top: tokenPopover.top, left: tokenPopover.left, width: tokenPopover.width, zIndex: 60 }}
            className="max-h-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_16px_48px_rgba(15,23,42,0.18)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <DataTree fields={dataFields} onInsert={insertToken} title="Insert data" emptyMessage="No earlier step data is available yet." />
          </div>,
          document.body,
        )}
      {issuesPopover && issueItems.length > 0 &&
        createPortal(
          <div
            ref={issuesPopoverRef}
            style={{ position: 'fixed', top: issuesPopover.top, left: issuesPopover.left, zIndex: 60 }}
            className="w-max max-w-xs rounded-xl border border-slate-200 bg-white p-3 shadow-[0_16px_48px_rgba(15,23,42,0.18)]"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <ul className="space-y-2">
              {issueItems.map((item, itemIndex) => (
                <li key={itemIndex} className="flex items-start gap-2 text-sm text-slate-700">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', item.level === 'error' ? 'bg-red-500' : 'bg-amber-500')} />
                  <span className="min-w-0">{humanize(item.message)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-slate-200 pt-2">
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


/** Compact "+ Add step" menu for loop bodies / parallel branches (was drawer-only). */
function AddNestedStepMenu({ label, onPick }: { label: string; onPick: (type: EditableType) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:border-blue-400 hover:text-blue-700"
      >
        <Plus className="h-4 w-4" /> {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
            {NODE_TYPES.map((type) => (
              <button
                key={type.value}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onPick(type.value)
                }}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-slate-100"
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

/** Step type + notes — the drawer's shared chrome, now inline on the card. */
function StepSettingsFooter({
  node,
  update,
  onChangeType,
  tokenWiring,
}: {
  node: FlowNode
  update: (node: FlowNode) => void
  onChangeType?: (type: EditableType) => void
  tokenWiring: TokenEditorWiring
}) {
  const { blockActive, unblockActive } = tokenWiring
  return (
    <div className="mt-4 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
      {onChangeType && (
        <div className="grid gap-1.5">
          <label className={labelClass}>Step type</label>
          <select value={node.type} onChange={(event) => onChangeType(event.target.value as EditableType)} className={controlClass}>
            {NODE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid gap-1.5">
        <label className={labelClass}>Notes (optional)</label>
        <input
          value={(node.data as { note?: string }).note ?? ''}
          placeholder="Why this step exists, gotchas, links…"
          onFocus={blockActive}
          onBlur={unblockActive}
          onChange={(event) => update({ ...node, data: { ...node.data, note: event.target.value || undefined } } as FlowNode)}
          className={controlClass}
        />
      </div>
    </div>
  )
}

function renderNodeBody({
  node,
  flowId,
  agents,
  toolCatalog,
  update,
  onRefreshAgents,
  tokenWiring,
  showErrors,
  variableNames,
  dataFields,
  onAddStep,
}: {
  node: FlowNode
  flowId?: string
  agents: Agent[]
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
  variableNames?: string[]
  dataFields?: DataField[]
  onAddStep?: (type: EditableType, branchIndex?: number) => void
}) {
  switch (node.type) {
    case 'trigger':
      return <TriggerBody node={node} update={update} flowId={flowId} />
    case 'agent':
      return <AgentBody node={node} agents={agents} update={update} onRefreshAgents={onRefreshAgents} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'http':
      return <HttpBody node={node} toolCatalog={toolCatalog} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'respondWebhook':
      return <RespondWebhookBody node={node} update={update} />
    case 'wait':
      return <WaitBody node={node} update={update} />
    case 'repeatUntil':
      return <RepeatUntilBody node={node} update={update} tokenWiring={tokenWiring} onAddStep={onAddStep} />
    case 'tool':
      return <ToolBody node={node} toolCatalog={toolCatalog} update={update} showErrors={showErrors} dataFields={dataFields ?? []} tokenWiring={tokenWiring} />
    case 'condition':
      return <ConditionBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'filter':
      return <ConditionBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'transform':
      return <TransformBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'loop':
      return <LoopBody node={node} update={update} tokenWiring={tokenWiring} onAddStep={onAddStep} />
    case 'parallel':
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Runs {node.data.branches.length || 0} branches side by side.</p>
          <div className="grid gap-1.5">
            <label className={labelClass}>Join strategy</label>
            <select
              value={node.data.join ?? ''}
              onChange={(event) => update({ ...node, data: { ...node.data, join: (event.target.value || undefined) as 'object' | 'array' | 'merge' | undefined } })}
              className={controlClass}
            >
              <option value="">Keyed object (default)</option>
              <option value="object">Object (keyed by labels)</option>
              <option value="array">Array (branch order)</option>
              <option value="merge">Merge (shallow-merge objects)</option>
            </select>
          </div>
          {onAddStep && <AddNestedStepMenu label="Add parallel branch" onPick={onAddStep} />}
        </div>
      )
    case 'switch':
      return <SwitchBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'stop':
      return <StopBody node={node} update={update} />
    case 'variable':
      return <VariableBody node={node} update={update} tokenWiring={tokenWiring} variableNames={variableNames} showErrors={showErrors} />
    case 'data':
      return <DataBody node={node} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'humanReview':
      return <HumanReviewBody node={node} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'router':
      return <RouterBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'errorShield':
      return <ErrorShieldBody node={node} onAddStep={onAddStep} />
    case 'input':
      return <p className="text-sm text-slate-600">Define the typed values callers may pass to this workflow.</p>
    case 'output':
      return <p className="text-sm text-slate-600">Define the values this workflow returns to callers.</p>
    case 'subflow':
      return <SubflowBody node={node} update={update} />
  }
}

function RespondWebhookBody({ node, update }: { node: Extract<FlowNode, { type: 'respondWebhook' }>; update: (node: FlowNode) => void }) {
  return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-2">
      <label className={labelClass}>Status code<input className={controlClass} type="number" min={100} max={599} value={node.data.statusCode} onChange={(event) => update({ ...node, data: { ...node.data, statusCode: Number(event.target.value) } })} /></label>
      <label className={labelClass}>Body type<select className={controlClass} value={node.data.bodyMode} onChange={(event) => update({ ...node, data: { ...node.data, bodyMode: event.target.value as typeof node.data.bodyMode } })}><option value="json">JSON</option><option value="text">Text</option><option value="binary">Binary (base64)</option><option value="none">No body</option></select></label>
    </div>
    <label className={labelClass}>Headers (JSON)<textarea className={controlClass} rows={2} value={node.data.headers ?? ''} onChange={(event) => update({ ...node, data: { ...node.data, headers: event.target.value } })} placeholder={'{"x-result":"ok"}'} /></label>
    {node.data.bodyMode !== 'none' && <label className={labelClass}>Response body<textarea className={controlClass} rows={4} value={node.data.body ?? ''} onChange={(event) => update({ ...node, data: { ...node.data, body: event.target.value } })} placeholder="{{step.previous.output}}" /></label>}
  </div>
}

function WaitBody({ node, update }: { node: Extract<FlowNode, { type: 'wait' }>; update: (node: FlowNode) => void }) {
  return <div className="grid grid-cols-2 gap-2">
    <label className={labelClass}>Amount<input className={controlClass} type="number" min={0} value={node.data.amount} onChange={(event) => update({ ...node, data: { ...node.data, amount: Number(event.target.value) } })} /></label>
    <label className={labelClass}>Unit<select className={controlClass} value={node.data.unit} onChange={(event) => update({ ...node, data: { ...node.data, unit: event.target.value as typeof node.data.unit } })}><option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label>
  </div>
}

function RepeatUntilBody({ node, update, tokenWiring, onAddStep }: { node: Extract<FlowNode, { type: 'repeatUntil' }>; update: (node: FlowNode) => void; tokenWiring: TokenEditorWiring; onAddStep?: (type: EditableType) => void }) {
  return <div className="space-y-3">
    <ConditionBody node={{ id: node.id, type: 'condition', data: { clauses: node.data.clauses, match: node.data.match } }} update={(updated) => updated.type === 'condition' && update({ ...node, data: { ...node.data, clauses: updated.data.clauses ?? [], match: updated.data.match } })} tokenWiring={tokenWiring} />
    <div className="grid grid-cols-2 gap-2"><label className={labelClass}>Maximum runs<input className={controlClass} type="number" min={1} max={1000} value={node.data.maxIterations} onChange={(event) => update({ ...node, data: { ...node.data, maxIterations: Number(event.target.value) } })} /></label><label className={labelClass}>Delay (ms)<input className={controlClass} type="number" min={0} max={60000} value={node.data.delayMs ?? 0} onChange={(event) => update({ ...node, data: { ...node.data, delayMs: Number(event.target.value) } })} /></label></div>
    {onAddStep && <AddNestedStepMenu label="Add repeated step" onPick={onAddStep} />}
  </div>
}

function SubflowBody({ node, update }: { node: Extract<FlowNode, { type: 'subflow' }>; update: (node: FlowNode) => void }) {
  return <div className="space-y-3"><label className={labelClass}>Workflow ID<input className={controlClass} value={node.data.flowId} onChange={(event) => update({ ...node, data: { ...node.data, flowId: event.target.value } })} /></label><label className={labelClass}>Inputs (JSON)<textarea className={controlClass} rows={4} value={node.data.input ?? ''} onChange={(event) => update({ ...node, data: { ...node.data, input: event.target.value } })} placeholder={'{"customer":"{{trigger.input.customer}}"}'} /></label></div>
}

function TriggerBody({
  node,
  update,
  flowId,
}: {
  node: Extract<FlowNode, { type: 'trigger' }>
  update: (node: FlowNode) => void
  flowId?: string
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
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:text-blue-900" onClick={() => copyText(value, label)}>
          <Copy className="h-3 w-3" /> Copy
        </button>
      </div>
      {pre ? (
        <pre className={cn('max-h-36 overflow-auto rounded bg-white px-2 py-1.5 text-[11px]', valueClass)}>{value}</pre>
      ) : (
        <p className={cn('break-all rounded bg-white px-2 py-1.5 font-mono text-[11px]', valueClass)}>{value}</p>
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
          <p className="text-xs text-slate-500">
            {schedule.type === 'cron' ? `Next run: per cron "${schedule.cron ?? ''}"` : `Next run: ${nextRunLabel}`}
          </p>
          <p className="text-xs text-slate-500">Scheduled runs execute the <strong>published</strong> version — publish the flow to arm the schedule.</p>
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
          <p className="text-xs text-slate-500">
            Fires when this signal is emitted anywhere in your workspace. The signal payload arrives as the Run input. Runs the published version.
          </p>
        </div>
      )}

      {type === 'activity' && <div className="space-y-3">
        <label className={labelClass}>Sources (optional)<input className={controlClass} value={(trigger.sources ?? []).join(', ')} onChange={(event) => setTrigger({ ...trigger, sources: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="slack, github" /></label>
        <label className={labelClass}>Actions (optional)<input className={controlClass} value={(trigger.actions ?? []).join(', ')} onChange={(event) => setTrigger({ ...trigger, actions: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="created, updated" /></label>
        <label className={labelClass}>Entity types (optional)<input className={controlClass} value={(trigger.entityTypes ?? []).join(', ')} onChange={(event) => setTrigger({ ...trigger, entityTypes: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="issue, message" /></label>
        <p className="text-xs text-slate-500">Filters normalized live activity from connected integrations. Leave a field blank to accept any value.</p>
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
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              {copyBlock('Webhook URL', webhook.url)}
              {webhook.testUrl && copyBlock('Test URL (runs current draft)', webhook.testUrl)}
              <div>
                {copyBlock('Auth header', webhookHeader, 'text-amber-700')}
                {!webhook.secret && <p className="mt-1 text-[11px] text-slate-500">A secret already exists. Rotate to mint and display a new one.</p>}
              </div>
              {copyBlock('Example JSON body', sampleWebhookBody, 'max-h-32', true)}
              {copyBlock('cURL', curlExample, undefined, true)}
            </div>
          )}
          <p className="text-xs text-slate-500">
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
              <label key={kind} className="flex items-center gap-2 text-sm text-slate-700">
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
            <p className="text-xs text-slate-500">Loaded from the selected Slack connection. Hold ⌘/Ctrl to select more than one.</p>
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Only when the message contains (optional)</label>
            <input className={controlClass} value={trigger.keyword ?? ''} placeholder="deploy" onChange={(event) => setTrigger({ ...trigger, keyword: event.target.value || undefined })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={trigger.threadMemory === true} onChange={(event) => setTrigger({ ...trigger, threadMemory: event.target.checked || undefined })} />
            Remember the conversation within a thread
          </label>
          {slackBinding ? (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <p className="text-xs text-slate-600">
                Slack bot: <strong>{slackBinding.teamName ?? 'Connected workspace'}</strong> ({slackBinding.status})
              </p>
              {copyBlock('Ingress URL', slackBinding.ingressUrl)}
            </div>
          ) : (
            <p className="text-xs text-amber-700">No Slack bot connected — add one on the Integrations page first.</p>
          )}
          <p className="text-xs text-slate-500">
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
              <div key={`${field.name}-${fieldIndex}`} className="grid gap-3 border-b border-slate-200 pb-3 sm:grid-cols-[42px_minmax(110px,0.7fr)_auto_minmax(140px,1fr)_auto_36px]">
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
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600" title="The run must supply this value">
                  <input
                    type="checkbox"
                    checked={field.required === true}
                    onChange={(event) => updateField(fieldIndex, { required: event.target.checked || undefined })}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => removeField(fieldIndex)}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
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
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="mb-3 text-sm font-semibold text-slate-900">Choose the type of user input</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {INPUT_TYPES.map((type) => {
              const InputIcon = type.icon
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => addField(type.id)}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
                >
                  <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', type.tone)}>
                    <InputIcon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-slate-900">{type.label}</span>
                    <span className="block text-xs text-slate-500">{type.description}</span>
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
          className="flex w-full items-center gap-3 rounded-lg py-2 text-left text-base font-semibold text-slate-700 hover:text-blue-700"
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
          helperClass="mt-1 text-xs text-slate-500"
        />
      )}
    </div>
  )
}

function AgentBody({
  node,
  agents,
  update,
  onRefreshAgents,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'agent' }>
  agents: Agent[]
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const isDefaultInput = defaultAgentInput(node.data.input)
  const responseFormat = node.data.responseFormat ?? 'text'
  const outputFields = node.data.outputFields ?? []
  const setOutputFields = (fields: OutputField[]) =>
    update({ ...node, data: { ...node.data, outputFields: fields.length ? fields : undefined } })
  // Inline-prompt mode: an ephemeral one-shot model call with no saved
  // AgentTask (model-runner.ts's generateText). Opens by default when the
  // node already carries a prompt (JSON/copilot-authored), otherwise the
  // saved-agent picker stays the default surface.
  const [showInlinePrompt, setShowInlinePrompt] = useState(Boolean(node.data.prompt?.trim()))
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Agent <span className="text-red-500">*</span></label>
        <div className="flex items-center gap-2">
          <select
            value={node.data.agentId}
            onChange={(event) => update({ ...node, data: { ...node.data, agentId: event.target.value } })}
            className={cn(controlClass, 'min-w-0 flex-1', showErrors && !node.data.agentId && 'border-red-400 focus:border-red-500')}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
          {onRefreshAgents && (
            <button
              type="button"
              onClick={onRefreshAgents}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Refresh agent list"
              title="Refresh agent list"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          <a
            href="/agents"
            target="_blank"
            rel="noreferrer"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            title="Create a new agent on the dashboard"
          >
            <Plus className="h-4 w-4" /> New
          </a>
        </div>
        <button
          type="button"
          onClick={() => setShowInlinePrompt((value) => !value)}
          className="w-fit text-xs font-semibold text-blue-700 hover:text-blue-900"
        >
          {showInlinePrompt ? 'Hide inline prompt' : 'Use an inline prompt instead of a saved agent'}
        </button>
      </div>
      {showInlinePrompt && (
        <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="grid gap-2">
            <label className={labelClass}>Prompt</label>
            <TokenTextEditor
              ref={registerEditor('agent.prompt')}
              multiline
              rows={4}
              value={node.data.prompt ?? ''}
              labelCtx={labelCtx}
              onFocus={focusEditor('agent.prompt')}
              onChange={(prompt) => update({ ...node, data: { ...node.data, prompt: prompt || undefined } })}
              className={tokenControlClass}
              placeholder="Run this prompt as a one-shot model call — no saved agent needed."
              ariaLabel="Inline prompt"
            />
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Model</label>
            <select
              value={node.data.model ?? ''}
              onChange={(event) => update({ ...node, data: { ...node.data, model: event.target.value || undefined } })}
              className={cn(controlClass, 'w-full sm:w-64')}
            >
              <option value="">Default</option>
              <option value="claude-opus-4-8">Claude Opus 4.8</option>
              <option value="claude-sonnet-5">Claude Sonnet 5</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
              <option value="qwen-3.7">Qwen 3.7</option>
            </select>
          </div>
        </div>
      )}
      <div className="grid gap-2">
        <label className={labelClass}>Message to agent</label>
        <TokenTextEditor
          ref={registerEditor('agent.input')}
          multiline
          rows={4}
          value={isDefaultInput ? '' : node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('agent.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          className={tokenControlClass}
          placeholder={isDefaultInput ? 'Uses the trigger input by default. Add instructions here if needed.' : 'Tell the agent what to do at this step.'}
          ariaLabel="Message to agent"
        />
      </div>
      <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 p-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Request human assistance when unsure</p>
          <p className="mt-0.5 text-xs text-slate-500">When the agent isn&apos;t sure how to proceed, the flow pauses and asks for input.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={node.data.humanAssistance !== false}
          aria-label="Request human assistance when unsure"
          onClick={() => update({ ...node, data: { ...node.data, humanAssistance: node.data.humanAssistance === false ? undefined : false } })}
          className={cn(
            'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
            node.data.humanAssistance !== false ? 'bg-blue-600' : 'bg-slate-300',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              node.data.humanAssistance !== false ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </button>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <label className={labelClass}>Agent response</label>
          <select
            value={responseFormat}
            onChange={(event) =>
              update({ ...node, data: { ...node.data, responseFormat: event.target.value === 'structured' ? 'structured' : undefined } })
            }
            className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 outline-none"
          >
            <option value="text">Text only</option>
            <option value="structured">Structured</option>
          </select>
        </div>
        <p className="text-xs text-slate-500">
          {responseFormat === 'structured'
            ? 'The agent must reply with JSON matching these properties; each becomes data for later steps.'
            : 'The agent replies with plain text. Switch to Structured to map fields into later steps.'}
        </p>
        {responseFormat === 'structured' && (
          <div className="space-y-2">
            {outputFields.map((field, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_36px]">
                <input
                  value={field.name}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  className={controlClass}
                  placeholder="propertyName"
                />
                <select
                  value={field.type}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, type: event.target.value as OutputField['type'] } : entry)))}
                  className={controlClass}
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setOutputFields(outputFields.filter((_, j) => j !== index))}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove property"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setOutputFields([...outputFields, { name: '', type: 'string' }])}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900"
            >
              Add property
            </button>
          </div>
        )}
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function HttpBody({
  node,
  toolCatalog,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'http' }>
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const urlInvalid = Boolean(showErrors && !node.data.url)
  const authConnections = toolCatalog.filter((entry) => parseFlowToolConnectionId(entry.id).plane === 'mcp')
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
        <div className="grid gap-2">
          <label className={labelClass}>URI <span className="text-red-500">*</span></label>
          <TokenTextEditor
            ref={registerEditor('http.url')}
            value={node.data.url}
            labelCtx={labelCtx}
            onFocus={focusEditor('http.url')}
            onChange={(url) => update({ ...node, data: { ...node.data, url } })}
            invalid={urlInvalid}
            className={cn(tokenControlBase, urlInvalid ? 'focus:border-red-500' : 'border-slate-300')}
            placeholder="https://api.example.com/endpoint"
            ariaLabel="URI"
          />
        </div>
        <div className="grid gap-2">
          <label className={labelClass}>Method <span className="text-red-500">*</span></label>
          <select
            value={node.data.method}
            onChange={(event) => update({ ...node, data: { ...node.data, method: event.target.value as typeof node.data.method } })}
            className={controlClass}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </div>
      </div>
      <InlineKeyValue
        label="Headers"
        editorKey="http.headers"
        value={node.data.headers}
        onChange={(headers) => update({ ...node, data: { ...node.data, headers } })}
        tokenWiring={tokenWiring}
      />
      <div className="grid gap-2">
        <label className={labelClass}>Authenticate with (optional)</label>
        <select
          value={node.data.connectionId ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, connectionId: event.target.value || undefined } })}
          className={controlClass}
        >
          <option value="">No authentication</option>
          {authConnections.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-slate-500">
          Uses this connection&apos;s login to authorize the request — connections shared with your workspace, plus your own. Your own Authorization header always takes precedence.
        </p>
      </div>
      <InlineKeyValue
        label="Queries"
        editorKey="http.query"
        value={node.data.query}
        onChange={(query) => update({ ...node, data: { ...node.data, query } })}
        tokenWiring={tokenWiring}
      />
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2"><label className={labelClass}>Body</label><select className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs" value={node.data.bodyMode ?? 'json'} onChange={(event) => update({ ...node, data: { ...node.data, bodyMode: event.target.value as typeof node.data.bodyMode } })}><option value="json">JSON</option><option value="text">Text</option><option value="raw">Raw</option><option value="formUrlencoded">Form URL encoded</option><option value="multipart">Multipart form</option><option value="binary">Binary (base64)</option><option value="none">No body</option></select></div>
        <TokenTextEditor
          ref={registerEditor('http.body')}
          multiline
          rows={4}
          value={node.data.body ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('http.body')}
          onChange={(body) => update({ ...node, data: { ...node.data, body } })}
          className={tokenControlClass}
          placeholder="Optional JSON or text body for POST, PUT, and PATCH requests."
          ariaLabel="Body"
        />
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Cookie</label>
        <TokenTextEditor
          ref={registerEditor('http.cookie')}
          value={node.data.cookie ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('http.cookie')}
          onChange={(cookie) => update({ ...node, data: { ...node.data, cookie: cookie || undefined } })}
          className={tokenControlClass}
          placeholder="name=value; other=value"
          ariaLabel="Cookie"
        />
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function InlineKeyValue({
  label,
  editorKey,
  value,
  onChange,
  tokenWiring,
}: {
  label: string
  editorKey: string
  value?: string
  onChange: (value: string) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const rows = parseKeyValueRows(value)
  const updateRow = (index: number, patch: Partial<KeyValueRow>) => {
    onChange(serializeKeyValueRows(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))))
  }
  const addRow = () => onChange(serializeKeyValueRows([...rows, { key: '', value: '' }]))
  const removeRow = (index: number) => onChange(serializeKeyValueRows(rows.filter((_, rowIndex) => rowIndex !== index)))

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <label className={labelClass}>{label}</label>
        <button type="button" onClick={addRow} className="text-xs font-semibold text-blue-700 hover:text-blue-900">
          Add row
        </button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={`${label}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
            <input
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              placeholder="Key"
            />
            <TokenTextEditor
              ref={registerEditor(`${editorKey}.${index}.value`)}
              value={row.value}
              labelCtx={labelCtx}
              onFocus={focusEditor(`${editorKey}.${index}.value`)}
              onChange={(next) => updateRow(index, { value: next })}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Value"
              ariaLabel={`${label} value`}
            />
            <button
              type="button"
              onClick={() => removeRow(index)}
              className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
              aria-label={`Remove ${label.toLowerCase()} row`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolBody({
  node,
  toolCatalog,
  update,
  showErrors,
  dataFields,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'tool' }>
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  showErrors?: boolean
  dataFields: DataField[]
  tokenWiring: TokenEditorWiring
}) {
  const { connection, tool: liveTool } = selectedTool(node.data.connectionId, node.data.toolName, toolCatalog)
  const tool = liveTool ?? (node.data.actionInputSchema ? { name: node.data.toolName, description: node.data.actionDescription ?? '', inputSchema: node.data.actionInputSchema, outputSchema: node.data.actionOutputSchema, schemaHash: node.data.actionSchemaHash ?? '', risk: node.data.risk ?? 'read' as const } : undefined)
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Connection <span className="text-red-500">*</span></label>
        <select
          value={node.data.connectionId}
          onChange={(event) => {
            const nextConnection = toolCatalog.find((entry) => entry.id === event.target.value)
            const selected = nextConnection?.tools[0]
            update({ ...node, data: { ...node.data, connectionId: event.target.value, toolName: selected?.name ?? '', actionDescription: selected?.description, actionInputSchema: selected?.inputSchema, actionOutputSchema: selected?.outputSchema, actionSchemaHash: selected?.schemaHash, risk: selected?.risk } })
          }}
          className={cn(controlClass, showErrors && !node.data.connectionId && 'border-red-400 focus:border-red-500')}
        >
          <option value="">Choose a connected tool</option>
          {toolCatalog.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>
      {connection && (
        <div className="grid gap-2">
          <label className={labelClass}>Action <span className="text-red-500">*</span></label>
          <select
            value={node.data.toolName}
            onChange={(event) => { const selected = connection.tools.find((entry) => entry.name === event.target.value); update({ ...node, data: { ...node.data, toolName: event.target.value, actionDescription: selected?.description, actionInputSchema: selected?.inputSchema, actionOutputSchema: selected?.outputSchema, actionSchemaHash: selected?.schemaHash, risk: selected?.risk } }) }}
            className={cn(controlClass, showErrors && !node.data.toolName && 'border-red-400 focus:border-red-500')}
          >
            <option value="">Choose an action</option>
            {connection.tools.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {connection ? (
        <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          <IntegrationLogo slug={connection.id} name={connection.name} className="h-8 w-8 rounded-lg bg-white p-1" />
          <p>{tool ? tool.description || 'Runs this exact tool with the arguments below.' : 'Choose the action this connection should run.'}</p>
        </div>
      ) : (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Connectors available on this workspace will show here.</p>
      )}
      {node.data.toolName && (
        <ToolArgsEditor
          inputSchema={tool?.inputSchema}
          args={node.data.args}
          onChange={(nextArgs) => update({ ...node, data: { ...node.data, args: nextArgs } })}
          dataFields={dataFields}
          labelCtx={tokenWiring.labelCtx}
        />
      )}
      {node.data.risk && node.data.risk !== 'read' && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">This action is classified as {node.data.risk} — it performs an external write when the flow runs.</p>}
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function ConditionBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'condition' | 'filter' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  // All clauses (legacy single left/op/right normalizes to one row).
  const clauses: ConditionClause[] = node.data.clauses?.length ? node.data.clauses : [firstClause(node)]
  const setClauses = (next: ConditionClause[]) =>
    update({ ...node, data: { ...node.data, clauses: next, match: node.data.match ?? 'all', left: undefined, op: undefined, right: undefined } } as FlowNode)
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-600">{node.type === 'condition' ? 'Route the flow based on a rule.' : 'Continue only when this rule is true.'}</p>
        {clauses.length > 1 && (
          <select
            value={node.data.match ?? 'all'}
            onChange={(event) => update({ ...node, data: { ...node.data, match: event.target.value as 'all' | 'any', clauses } } as FlowNode)}
            className={cn(controlClass, 'w-auto py-1 text-xs')}
            aria-label="Match all or any rules"
          >
            <option value="all">All match</option>
            <option value="any">Any match</option>
          </select>
        )}
      </div>
      {clauses.map((clause, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_150px_1fr_auto]">
          <TokenTextEditor
            ref={registerEditor(`clause.${index}.left`)}
            value={clause.left}
            labelCtx={labelCtx}
            onFocus={focusEditor(`clause.${index}.left`)}
            onChange={(left) => setClauses(clauses.map((c, j) => (j === index ? { ...c, left } : c)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Field or value"
            ariaLabel={`Rule ${index + 1} field or value`}
          />
          <select
            value={clause.op}
            onChange={(event) => setClauses(clauses.map((c, j) => (j === index ? { ...c, op: event.target.value as ConditionOp } : c)))}
            className={controlClass}
          >
            {CONDITION_OPS.map((op) => (
              <option key={op} value={op}>
                {CONDITION_OP_LABELS[op]}
              </option>
            ))}
          </select>
          <TokenTextEditor
            ref={registerEditor(`clause.${index}.right`)}
            value={clause.right}
            labelCtx={labelCtx}
            onFocus={focusEditor(`clause.${index}.right`)}
            onChange={(right) => setClauses(clauses.map((c, j) => (j === index ? { ...c, right } : c)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Compare to"
            ariaLabel={`Rule ${index + 1} comparison`}
          />
          {clauses.length > 1 ? (
            <button
              type="button"
              onClick={() => setClauses(clauses.filter((_, j) => j !== index))}
              className="self-center px-1 text-red-500 hover:text-red-700"
              aria-label={`Remove rule ${index + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => setClauses([...clauses, { left: '', op: 'contains', right: '' }])}
        className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add rule
      </button>
    </div>
  )
}

function TransformBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'transform' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const fields = transformFields(node)
  const setFields = (next: typeof fields) => update({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Create a clean object for later steps.</p>
      {fields.map((field, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
          <input
            value={field.name}
            onChange={(event) => setFields(fields.map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, name: event.target.value } : entry)))}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={controlClass}
            placeholder="Output field"
          />
          <TokenTextEditor
            ref={registerEditor(`xf.${index}`)}
            value={field.value}
            labelCtx={labelCtx}
            onFocus={focusEditor(`xf.${index}`)}
            onChange={(value) => setFields(fields.map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, value } : entry)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Value"
            ariaLabel={`Value for field ${field.name || index + 1}`}
          />
          <button
            type="button"
            onClick={() => setFields(fields.filter((_, fieldIndex) => fieldIndex !== index))}
            className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
            aria-label="Remove field"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setFields([...fields, { name: '', value: '' }])} className="text-sm font-semibold text-blue-700 hover:text-blue-900">
        Add field
      </button>
    </div>
  )
}

function LoopBody({
  node,
  update,
  tokenWiring,
  onAddStep,
}: {
  node: Extract<FlowNode, { type: 'loop' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  onAddStep?: (type: EditableType, branchIndex?: number) => void
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const usesTriggerInput = node.data.over === '{{trigger.input}}'
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Run the steps inside this loop once for each item in a list.</p>
      <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
        <select
          value={usesTriggerInput ? 'trigger' : 'custom'}
          onChange={(event) => update({ ...node, data: { ...node.data, over: event.target.value === 'trigger' ? '{{trigger.input}}' : '' } })}
          className={controlClass}
        >
          <option value="trigger">Trigger input</option>
          <option value="custom">Custom list</option>
        </select>
        {usesTriggerInput ? (
          <input value="" readOnly className={controlClass} placeholder="Uses trigger input" disabled aria-label="Items to process" />
        ) : (
          <TokenTextEditor
            ref={registerEditor('loop.over')}
            value={node.data.over}
            labelCtx={labelCtx}
            onFocus={focusEditor('loop.over')}
            onChange={(over) => update({ ...node, data: { ...node.data, over } })}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Comma-separated list, JSON array, or mapped list"
            ariaLabel="Items to process"
          />
        )}
      </div>
      {onAddStep && <AddNestedStepMenu label="Add step to loop" onPick={onAddStep} />}
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function ErrorShieldBody({
  node: _node,
  onAddStep,
}: {
  node: Extract<FlowNode, { type: 'errorShield' }>
  onAddStep?: (type: EditableType, branchIndex?: number) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Runs the body below. If a body step fails, the fallback runs instead — with the error available as{' '}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{'{{error}}'}</code> — and this step still succeeds.
      </p>
      {onAddStep && <AddNestedStepMenu label="Add step to body" onPick={onAddStep} />}
      {onAddStep && <AddNestedStepMenu label="Add fallback step" onPick={(type) => onAddStep(type, -1)} />}
    </div>
  )
}

function SwitchBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'switch' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const cases = node.data.cases.length ? node.data.cases : [switchFirstCase(node)]
  const setCases = (next: typeof cases) => update({ ...node, data: { ...node.data, cases: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Route to the first matching case, otherwise use the default path.</p>
      {cases.map((c, index) => (
        <div key={c.id} className="space-y-2 rounded-lg border border-slate-200 p-2.5">
          <div className="flex gap-2">
            <input
              value={c.label ?? ''}
              placeholder={`Case ${index + 1} label`}
              onChange={(event) => setCases(cases.map((x, j) => (j === index ? { ...x, label: event.target.value } : x)))}
              className={cn(controlClass, 'flex-1')}
              aria-label={`Case ${index + 1} label`}
            />
            {cases.length > 1 && (
              <button
                type="button"
                onClick={() => setCases(cases.filter((_, j) => j !== index))}
                className="px-1 text-red-500 hover:text-red-700"
                aria-label={`Remove case ${index + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_150px_1fr]">
            <TokenTextEditor
              ref={registerEditor(`sw.${index}.left`)}
              value={c.left}
              labelCtx={labelCtx}
              onFocus={focusEditor(`sw.${index}.left`)}
              onChange={(left) => setCases(cases.map((x, j) => (j === index ? { ...x, left } : x)))}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Field or value"
              ariaLabel={`Case ${index + 1} value`}
            />
            <select
              value={c.op}
              onChange={(event) => setCases(cases.map((x, j) => (j === index ? { ...x, op: event.target.value as ConditionOp } : x)))}
              className={controlClass}
            >
              {CONDITION_OPS.map((op) => (
                <option key={op} value={op}>
                  {CONDITION_OP_LABELS[op]}
                </option>
              ))}
            </select>
            <TokenTextEditor
              ref={registerEditor(`sw.${index}.right`)}
              value={c.right}
              labelCtx={labelCtx}
              onFocus={focusEditor(`sw.${index}.right`)}
              onChange={(right) => setCases(cases.map((x, j) => (j === index ? { ...x, right } : x)))}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Compare to"
              ariaLabel={`Case ${index + 1} comparison`}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setCases([...cases, { id: `case${cases.length + 1}-${Math.random().toString(36).slice(2, 6)}`, left: '', op: 'contains', right: '' }])
        }
        className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add case
      </button>
    </div>
  )
}

function RouterBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'router' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const branches = node.data.branches.length ? node.data.branches : [routerFirstBranch(node)]
  const setBranches = (next: typeof branches) => update({ ...node, data: { ...node.data, branches: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        An AI model reads the routing input, weighs it against each branch&apos;s description below, and continues down the best match — otherwise the <strong>default</strong> path.
      </p>
      <div className="grid gap-2">
        <label className={labelClass}>Routing input</label>
        <TokenTextEditor
          ref={registerEditor('router.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('router.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          className={cn(tokenControlClass, 'min-w-0')}
          placeholder="The value the AI routes on, e.g. {{trigger.input}}"
          ariaLabel="Routing input"
        />
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Routing instructions (optional)</label>
        <TokenTextEditor
          ref={registerEditor('router.instructions')}
          multiline
          rows={3}
          value={node.data.instructions ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('router.instructions')}
          onChange={(instructions) => update({ ...node, data: { ...node.data, instructions: instructions || undefined } })}
          className={tokenControlClass}
          placeholder="Extra guidance for the model making the routing decision"
          ariaLabel="Routing instructions"
        />
      </div>
      <div className="space-y-2">
        {branches.map((branch, index) => (
          <div key={branch.id} className="space-y-2 rounded-lg border border-slate-200 p-2.5">
            <div className="flex gap-2">
              <input
                value={branch.label ?? ''}
                placeholder={`Branch ${index + 1} label`}
                onChange={(event) => setBranches(branches.map((b, j) => (j === index ? { ...b, label: event.target.value } : b)))}
                className={cn(controlClass, 'flex-1')}
                aria-label={`Branch ${index + 1} label`}
              />
              {branches.length > 1 && (
                <button
                  type="button"
                  onClick={() => setBranches(branches.filter((_, j) => j !== index))}
                  className="px-1 text-red-500 hover:text-red-700"
                  aria-label={`Remove branch ${index + 1}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            <textarea
              value={branch.description ?? ''}
              onChange={(event) => setBranches(branches.map((b, j) => (j === index ? { ...b, description: event.target.value } : b)))}
              rows={2}
              className={cn(controlClass, 'h-auto w-full min-h-[64px] resize-y py-2')}
              placeholder="What routes here — the AI picks the branch by this description"
              aria-label={`Branch ${index + 1} description`}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          setBranches([...branches, { id: `branch${branches.length + 1}-${Math.random().toString(36).slice(2, 6)}`, label: '', description: '' }])
        }
        className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add branch
      </button>
    </div>
  )
}

function StopBody({ node, update }: { node: Extract<FlowNode, { type: 'stop' }>; update: (node: FlowNode) => void }) {
  return (
    <div className="grid gap-2">
      <label className={labelClass}>Message</label>
      <input
        value={node.data.reason ?? ''}
        onChange={(event) => update({ ...node, data: { ...node.data, reason: event.target.value } })}
        className={controlClass}
        placeholder="Optional reason shown when this flow stops"
      />
    </div>
  )
}

function VariableBody({
  node,
  update,
  tokenWiring,
  variableNames,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'variable' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  variableNames?: string[]
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const isInitialize = node.data.op === 'initialize'
  const currentName = node.data.name.trim()
  // Mutation ops pick from variables initialized earlier; keep a name that is
  // not in that list selectable (it may live in a sibling branch).
  const nameOptions = [...(variableNames ?? []), ...(currentName && !(variableNames ?? []).includes(currentName) ? [currentName] : [])]
  const setOp = (op: VariableOp) =>
    update({ ...node, data: { ...node.data, op, varType: op === 'initialize' ? node.data.varType ?? 'string' : undefined } })
  const nameInvalid = Boolean(showErrors && !currentName)
  const valueInvalid = Boolean(showErrors && !variableValueOptional(node.data.op) && !node.data.value?.trim())
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Operation</label>
        <select value={node.data.op} onChange={(event) => setOp(event.target.value as VariableOp)} className={controlClass}>
          {VARIABLE_OPS.map((op) => (
            <option key={op} value={op}>
              {VARIABLE_OP_LABELS[op]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Name <span className="text-red-500">*</span></label>
        {isInitialize || nameOptions.length === 0 ? (
          <input
            value={node.data.name}
            onChange={(event) => update({ ...node, data: { ...node.data, name: event.target.value } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={cn(controlClass, nameInvalid && 'border-red-400 focus:border-red-500')}
            placeholder="Enter variable name"
            aria-label="Variable name"
          />
        ) : (
          <select
            value={currentName}
            onChange={(event) => update({ ...node, data: { ...node.data, name: event.target.value } })}
            className={cn(controlClass, nameInvalid && 'border-red-400 focus:border-red-500')}
            aria-label="Variable name"
          >
            <option value="">Choose a variable</option>
            {nameOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {!isInitialize && nameOptions.length === 0 && (
          <p className="text-xs text-slate-500">No variables are initialized earlier in this flow — add an Initialize variable step first, or type the name it will use.</p>
        )}
      </div>
      {isInitialize && (
        <div className="grid gap-2">
          <label className={labelClass}>Type <span className="text-red-500">*</span></label>
          <select
            value={node.data.varType ?? 'string'}
            onChange={(event) => update({ ...node, data: { ...node.data, varType: event.target.value as VariableType } })}
            className={controlClass}
          >
            {VARIABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {VARIABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid gap-2">
        <label className={labelClass}>
          Value {variableValueOptional(node.data.op) ? <span className="font-normal normal-case text-slate-400">(optional)</span> : <span className="text-red-500">*</span>}
        </label>
        <TokenTextEditor
          ref={registerEditor('var.value')}
          value={node.data.value ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('var.value')}
          onChange={(value) => update({ ...node, data: { ...node.data, value } })}
          invalid={valueInvalid}
          className={cn(tokenControlBase, valueInvalid ? 'focus:border-red-500' : 'border-slate-300')}
          placeholder={VARIABLE_VALUE_PLACEHOLDER[node.data.op]}
          ariaLabel="Variable value"
        />
      </div>
    </div>
  )
}

function DataBody({
  node,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'data' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const op = node.data.op
  const setOp = (next: DataOp) => {
    // Ops with required list config start with one empty row so the editor
    // opens ready to fill in.
    const clauses = next === 'filterArray' && !(node.data.clauses ?? []).length ? [{ left: '', op: 'contains' as ConditionOp, right: '' }] : node.data.clauses
    const fields = next === 'select' && !(node.data.fields ?? []).length ? [{ name: '', value: '' }] : node.data.fields
    update({ ...node, data: { ...node.data, op: next, clauses, fields } })
  }
  const inputInvalid = Boolean(showErrors && !node.data.input?.trim())
  const clauses = node.data.clauses ?? []
  const fields = node.data.fields ?? []
  const setClauses = (next: ConditionClause[]) => update({ ...node, data: { ...node.data, clauses: next } })
  const setFields = (next: { name: string; value: string }[]) => update({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Operation</label>
        <select value={op} onChange={(event) => setOp(event.target.value as DataOp)} className={controlClass}>
          {DATA_OPS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_OP_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Input <span className="text-red-500">*</span></label>
        <TokenTextEditor
          ref={registerEditor('data.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('data.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          invalid={inputInvalid}
          className={cn(tokenControlBase, inputInvalid ? 'focus:border-red-500' : 'border-slate-300')}
          placeholder={DATA_OP_INPUT_PLACEHOLDER[op]}
          ariaLabel="Input"
        />
      </div>
      {op === 'join' && (
        <div className="grid gap-2">
          <label className={labelClass}>Join with <span className="font-normal normal-case text-slate-400">(optional)</span></label>
          <input
            value={node.data.separator ?? ''}
            onChange={(event) => update({ ...node, data: { ...node.data, separator: event.target.value || undefined } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={controlClass}
            placeholder="Defaults to a comma"
            aria-label="Join with"
          />
        </div>
      )}
      {op === 'parseJson' && (
        <div className="grid gap-2">
          <label className={labelClass}>Schema <span className="font-normal normal-case text-slate-400">(optional)</span></label>
          <textarea
            rows={4}
            value={node.data.schema ?? ''}
            onChange={(event) => update({ ...node, data: { ...node.data, schema: event.target.value || undefined } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={cn(controlClass, 'h-auto resize-y py-2 font-mono text-xs')}
            placeholder="A JSON Schema describing the parsed shape"
            aria-label="Schema"
          />
          <p className="text-xs text-slate-500">Optional — stored for reference.</p>
        </div>
      )}
      {op === 'filterArray' && (
        <div className="grid gap-2">
          <label className={labelClass}>Conditions <span className="text-red-500">*</span></label>
          {(clauses.length ? clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]).map((clause, index, list) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_130px_1fr_36px]">
              <TokenTextEditor
                ref={registerEditor(`data.clause.${index}.left`)}
                value={clause.left}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.clause.${index}.left`)}
                onChange={(left) => setClauses(list.map((entry, j) => (j === index ? { ...entry, left } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Item field to check"
                ariaLabel={`Condition ${index + 1} value`}
              />
              <select
                value={clause.op}
                onChange={(event) => setClauses(list.map((entry, j) => (j === index ? { ...entry, op: event.target.value as ConditionOp } : entry)))}
                className={controlClass}
              >
                {CONDITION_OPS.map((entry) => (
                  <option key={entry} value={entry}>
                    {CONDITION_OP_LABELS[entry]}
                  </option>
                ))}
              </select>
              <TokenTextEditor
                ref={registerEditor(`data.clause.${index}.right`)}
                value={clause.right}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.clause.${index}.right`)}
                onChange={(right) => setClauses(list.map((entry, j) => (j === index ? { ...entry, right } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Compare to"
                ariaLabel={`Condition ${index + 1} comparison value`}
              />
              <button
                type="button"
                onClick={() => setClauses(list.filter((_, j) => j !== index))}
                disabled={list.length === 1}
                className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Remove condition"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setClauses([...(clauses.length ? clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]), { left: '', op: 'contains', right: '' }])}
            className="text-left text-sm font-semibold text-blue-700 hover:text-blue-900"
          >
            Add condition
          </button>
        </div>
      )}
      {op === 'select' && (
        <div className="grid gap-2">
          <label className={labelClass}>Fields <span className="text-red-500">*</span></label>
          {(fields.length ? fields : [{ name: '', value: '' }]).map((field, index, list) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
              <input
                value={field.name}
                onChange={(event) => setFields(list.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                onFocus={blockActive}
                onBlur={unblockActive}
                className={controlClass}
                placeholder="Output field"
              />
              <TokenTextEditor
                ref={registerEditor(`data.field.${index}.value`)}
                value={field.value}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.field.${index}.value`)}
                onChange={(value) => setFields(list.map((entry, j) => (j === index ? { ...entry, value } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Value for this field"
                ariaLabel={`Value for field ${field.name || index + 1}`}
              />
              <button
                type="button"
                onClick={() => setFields(list.filter((_, j) => j !== index))}
                disabled={list.length === 1}
                className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Remove field"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFields([...(fields.length ? fields : [{ name: '', value: '' }]), { name: '', value: '' }])}
            className="text-left text-sm font-semibold text-blue-700 hover:text-blue-900"
          >
            Add field
          </button>
        </div>
      )}
      <p className="text-xs text-slate-500">{DATA_OP_HELPER[op]}</p>
    </div>
  )
}

function HumanReviewBody({
  node,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'humanReview' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const messageInvalid = Boolean(showErrors && !node.data.message.trim())
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Message <span className="text-red-500">*</span></label>
        <TokenTextEditor
          ref={registerEditor('hr.message')}
          multiline
          rows={4}
          value={node.data.message}
          labelCtx={labelCtx}
          onFocus={focusEditor('hr.message')}
          onChange={(message) => update({ ...node, data: { ...node.data, message } })}
          invalid={messageInvalid}
          className={cn(tokenControlBase, messageInvalid ? 'focus:border-red-500' : 'border-slate-300')}
          placeholder="What should the person be asked? Their reply becomes this step's output."
          ariaLabel="Message"
        />
      </div>
      {/* No org-member roster is fetched anywhere in the builder today, so an
          assignee select would need a new members API + fetch. v1 keeps the
          engine default (data.assigneeUserId unset = the run owner is asked)
          and says so in plain english. */}
      <div className="grid gap-2">
        <label className={labelClass}>Assigned to</label>
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">The flow owner is asked by default. The run pauses here until they reply, and the reply becomes this step&apos;s output.</p>
      </div>
    </div>
  )
}
