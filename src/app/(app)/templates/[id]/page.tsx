'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Bot, CalendarClock, Copy, Pencil, RotateCcw, Save, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { HtmlPreview, looksLikeHtml } from '@/components/ui/html-preview'
import { TemplateSchedulePicker } from '@/components/templates/template-schedule-picker'
import { missingIntegrations, connectedSlugSet } from '@/lib/templates/relevance'
import { findTemplateForRoute } from '@/lib/templates/route-id'
import { exampleArtifactHtml } from '@/lib/templates/example-artifact'
import { MAX_OVERRIDE_DESCRIPTION, MAX_OVERRIDE_INSTRUCTIONS, MAX_OVERRIDE_NAME, type TemplateOverrides } from '@/lib/templates/overrides'
import { MODEL_CATALOG, modelLabel } from '@/lib/llm/model-catalog'
import type { ScheduleDraft } from '@/lib/agents/schedule-form'
import { getCachedJson, invalidateCachedJson } from '@/lib/client/use-cached-json'
import { describeSchedule } from '@/lib/scheduling/describe-schedule'
import { useViewerTimeZone } from '@/lib/scheduling/use-viewer-time-zone'

type Template = {
  id: string
  name: string
  description: string
  category?: string
  instructions: string
  integrations: string[]
  skills?: string[]
  tags?: string[]
  model: string
  exampleOutput?: string
  icon?: string
  allowSubagents?: boolean
  subagentIds?: string[]
  goal?: string
  autoAnswerFromMemory?: boolean
  alwaysStrategize?: boolean
  maxTurns?: number
  outputFields?: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description?: string }>
  schedule?: ScheduleDraft
  // Seed-catalogue metadata (additive; absent on legacy DB-authored templates).
  kind?: 'agent' | 'flow'
  seed?: boolean
  seedKey?: string
  /** The viewer's own org authored this row, so it can be edited in place. */
  mine?: boolean
  requiredIntegrations?: string[]
  recommendedIntegrations?: string[]
  departments?: string[]
  trigger?: {
    type?: string
    schedule?: { type?: string; cron?: string; time?: string; timezone?: string; isActive?: boolean }
  }
}

type ProvisionKind = 'agent' | 'flow'

/** Deploy as its own standalone agent — the behaviour before workers existed. */
const SOLO = 'solo'
/** Deploy under a brand-new worker, named in the adjacent field. */
const NEW_WORKER = 'new'

type CatalogConnection = { id: string; name: string }

/** Same normalization the server's binding pass uses (provision-plan.ts). */
const bindSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

const MANUAL_SCHEDULE: ScheduleDraft = { type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false }

/** The customizable fields, as the user sees and edits them. */
type Draft = {
  name: string
  description: string
  instructions: string
  model: string
  schedule: ScheduleDraft
}

function templateSchedule(template: Template): ScheduleDraft {
  const schedule = template.trigger?.type === 'schedule' ? template.trigger.schedule : undefined
  if (schedule) {
    return {
      type: (schedule.type as ScheduleDraft['type']) || 'cron',
      time: schedule.time || '',
      cron: schedule.cron || '',
      timezone: schedule.timezone || 'UTC',
      isActive: schedule.isActive !== false,
    }
  }
  const stored = template.schedule
  return stored && stored.type
    ? { type: stored.type, time: stored.time ?? '', cron: stored.cron ?? '', timezone: stored.timezone || 'UTC', runAt: stored.runAt, isActive: Boolean(stored.isActive) }
    : MANUAL_SCHEDULE
}

function draftFrom(template: Template): Draft {
  return {
    name: template.name,
    description: template.description,
    instructions: template.instructions,
    model: template.model,
    schedule: templateSchedule(template),
  }
}

function sameSchedule(a: ScheduleDraft, b: ScheduleDraft): boolean {
  const inert = (s: ScheduleDraft) => s.type === 'manual' || !s.isActive
  if (inert(a) && inert(b)) return true
  return a.type === b.type && (a.time ?? '') === (b.time ?? '') && (a.cron ?? '') === (b.cron ?? '')
    && (a.timezone || 'UTC') === (b.timezone || 'UTC') && Boolean(a.isActive) === Boolean(b.isActive)
}

/** Only what differs from the template — the server treats each key's presence as the edit. */
function overridesFrom(draft: Draft, original: Draft): TemplateOverrides {
  const overrides: TemplateOverrides = {}
  // Both sides trimmed: a stored value with stray whitespace must not read
  // as an edit the user never made.
  if (draft.name.trim() !== original.name.trim()) overrides.name = draft.name.trim()
  if (draft.description.trim() !== original.description.trim()) overrides.description = draft.description.trim()
  if (draft.instructions.trim() !== original.instructions.trim()) overrides.instructions = draft.instructions.trim()
  if (draft.model !== original.model) overrides.model = draft.model
  if (!sameSchedule(draft.schedule, original.schedule)) {
    overrides.schedule = {
      type: draft.schedule.type, time: draft.schedule.time ?? '', cron: draft.schedule.cron ?? '',
      timezone: draft.schedule.timezone || 'UTC', ...(draft.schedule.runAt ? { runAt: draft.schedule.runAt } : {}),
      isActive: draft.schedule.type !== 'manual',
    }
  }
  return overrides
}

function scheduleLabel(schedule: ScheduleDraft, viewerTimeZone: string): string {
  if (!schedule.isActive || schedule.type === 'manual') return 'Run manually or add a schedule after connecting'
  return describeSchedule({ ...schedule, time: schedule.time ?? '', cron: schedule.cron ?? '' }, viewerTimeZone, new Date())
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function exampleHtml(template: Template): string {
  // Seed templates always receive a full, styled example deliverable. Their
  // older one-line examples are retained in the catalogue for compatibility,
  // but are not representative enough for this detail-page preview.
  if (template.seed) return exampleArtifactHtml(template)
  if (template.exampleOutput?.trim()) {
    if (looksLikeHtml(template.exampleOutput)) return template.exampleOutput
    return `<section><h2>Example result</h2><p>${escapeHtml(template.exampleOutput).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p></section>`
  }
  return exampleArtifactHtml(template)
}

/** Sonner needs a route-independent id so a repeat deploy replaces the notice. */
const IGNORED_TOAST = 'template-ignored-overrides'

export default function TemplateDetails() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [template, setTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [deploying, setDeploying] = useState<ProvisionKind | null>(null)
  // Customization: the draft starts as the template and diverges as the user
  // edits. Deploys send only the diff; saving persists it as a template row.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  // Which roster identity this template joins. A template no longer has to
  // stand up its own agent — it can become another job for someone already
  // on the team, so one avatar covers several jobs.
  const [workers, setWorkers] = useState<{ id: string; name: string }[]>([])
  const [assignTo, setAssignTo] = useState<string>(SOLO)
  const [newWorkerName, setNewWorkerName] = useState('')
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const [catalog, setCatalog] = useState<CatalogConnection[]>([])
  // Multi-account workspaces: provider slug → pinned catalog connection id.
  const [accountChoices, setAccountChoices] = useState<Record<string, string>>({})
  // Falls back to the schedule's own zone until the browser resolves the
  // reader's, so the first paint matches what the server rendered.
  const viewerTimeZone = useViewerTimeZone(
    template ? templateSchedule(template).timezone : 'UTC',
  )

  useEffect(() => {
    setLoading(true)
    setLoadError('')
    getCachedJson<any>('/api/agent-templates')
      .then((data) => {
        const match = findTemplateForRoute<Template>(data.templates || [], id)
        if (!match) throw new Error('This template could not be found.')
        setTemplate(match)
        setDraft(draftFrom(match))
        setEditing(false)
      })
      .catch((error) => {
        setTemplate(null)
        setLoadError(error instanceof Error ? error.message : 'Could not load this template.')
      })
      .finally(() => setLoading(false))
  }, [id, reloadKey])

  useEffect(() => {
    getCachedJson<any>('/api/integrations/available', 30_000)
      .then((data) => setConnected(connectedSlugSet(data.tools || [])))
      .catch(() => setConnected(new Set()))
    getCachedJson<any>('/api/workers', 30_000)
      .then((data) => setWorkers(Array.isArray(data.workers) ? data.workers : []))
      .catch(() => setWorkers([]))
    getCachedJson<any>('/api/flows/tool-catalog', 30_000)
      .then((data) => setCatalog(Array.isArray(data.connections) ? data.connections : []))
      .catch(() => setCatalog([]))
  }, [])

  const original = useMemo(() => (template ? draftFrom(template) : null), [template])
  const overrides = useMemo(() => (draft && original ? overridesFrom(draft, original) : {}), [draft, original])
  const customizedFields = Object.keys(overrides) as Array<keyof TemplateOverrides>
  const dirty = customizedFields.length > 0
  const draftValid = Boolean(draft?.name.trim() && draft?.instructions.trim())
  // The current model may predate the catalogue (seeds default to an id the
  // picker does not list) — keep it selectable rather than silently swapping.
  const modelOptions = useMemo(() => {
    const current = draft?.model
    return current && !MODEL_CATALOG.some((model) => model.id === current)
      ? [{ id: current, label: current, provider: 'anthropic' as const }, ...MODEL_CATALOG]
      : [...MODEL_CATALOG]
  }, [draft?.model])

  const missing = template ? missingIntegrations(template.requiredIntegrations ?? [], connected) : []

  // Providers where the workspace has SEVERAL satisfying connections — the
  // only case where "which account?" is a real question. Single-account
  // providers bind deterministically server-side with no UI.
  const ambiguousProviders = (template?.requiredIntegrations ?? [])
    .map((provider) => ({ provider, matches: catalog.filter((c) => bindSlug(c.name) === bindSlug(provider)) }))
    .filter((entry) => entry.matches.length > 1)

  const resetDraft = () => {
    if (template) setDraft(draftFrom(template))
  }

  // Every template — seed or community — deploys through the trusted
  // server-side provision route: instructions, schedule, and connection
  // bindings are resolved there, never assembled client-side. Edits travel
  // as `overrides`, which the server applies onto the re-read recipe.
  const connect = async (targetKind: ProvisionKind) => {
    if (!template || deploying) return
    if (dirty && !draftValid) {
      toast.error('Give the template a name and instructions before deploying.')
      return
    }
    setDeploying(targetKind)
    try {
      // Only agents join a worker; a flow is not a person on the roster.
      let workerId: string | undefined
      if (targetKind === 'agent' && assignTo !== SOLO) {
        if (assignTo === NEW_WORKER) {
          const created = await fetch('/api/workers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newWorkerName.trim() || draft?.name.trim() || template.name }),
          })
          const createdBody = await created.json().catch(() => ({}))
          // Hiring is a separate write, so a failure here must stop the deploy
          // rather than quietly producing a standalone agent the user did not ask for.
          if (!created.ok) throw new Error(createdBody.error || 'Could not create that worker.')
          workerId = createdBody.worker?.id
        } else {
          workerId = assignTo
        }
      }
      const response = await fetch('/api/templates/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(template.seed ? { seedKey: template.seedKey } : { templateId: template.id }),
          targetKind,
          // 1-click: a flow deploy publishes + activates in the same call
          // (server degrades to DRAFT if the graph fails validation).
          activate: targetKind === 'flow',
          ...(Object.keys(accountChoices).length ? { connectionOverrides: accountChoices } : {}),
          ...(workerId ? { workerId } : {}),
          ...(dirty ? { overrides } : {}),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (data.code === 'MISSING_INTEGRATIONS') {
          toast.error(data.error || 'Connect the required integrations first.', {
            action: { label: 'Open integrations', onClick: () => router.push('/integrations') },
          })
          return
        }
        throw new Error(data.error || `Could not connect this template to a ${targetKind}.`)
      }
      // An OK response missing its id must still surface — falling through
      // silently cleared the spinner and stranded the user on this page.
      if (data.deliveryWarning) toast.info(data.deliveryWarning, { duration: 12000 })
      if (Array.isArray(data.ignoredOverrides) && data.ignoredOverrides.length) {
        toast.info('This multi-step flow keeps its own per-step agent instructions — edit them in the flow builder.', { id: IGNORED_TOAST, duration: 12000 })
      }
      if (targetKind === 'flow' && data.flowId) {
        toast.success(data.activated ? 'Flow deployed and active.' : 'Flow created as a draft — review and publish it.')
        router.push(`/flows/${data.flowId}`)
      } else if (targetKind === 'agent' && data.agentId) {
        router.push(`/agents?agent=${data.agentId}`)
      } else {
        throw new Error(`Provisioning finished but returned no ${targetKind} — please try again.`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not connect this template.')
    } finally {
      setDeploying(null)
    }
  }

  const persistedSchedule = (schedule: ScheduleDraft) =>
    schedule.type === 'manual' || !schedule.isActive
      ? { type: 'manual', cron: '', time: '', timezone: schedule.timezone || 'UTC', isActive: false }
      : { type: schedule.type, cron: schedule.cron ?? '', time: schedule.time ?? '', timezone: schedule.timezone || 'UTC', ...(schedule.runAt ? { runAt: schedule.runAt } : {}), isActive: true }

  // Persist the edits on the viewer's OWN template row (PUT). Only offered
  // when the org authored it — a seed or another workspace's community
  // template is forked instead (saveAsMine).
  const saveChanges = async () => {
    if (!template || !draft || !template.mine || saving) return
    if (!draftValid) { toast.error('A template needs a name and instructions.'); return }
    setSaving(true)
    try {
      const response = await fetch('/api/agent-templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: template.id,
          name: draft.name.trim(),
          description: draft.description.trim(),
          instructions: draft.instructions.trim(),
          model: draft.model,
          schedule: persistedSchedule(draft.schedule),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save this template.')
      invalidateCachedJson('/api/agent-templates')
      toast.success('Template saved.')
      setReloadKey((key) => key + 1)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save this template.')
    } finally {
      setSaving(false)
    }
  }

  // Fork the customized template into the viewer's catalogue: a full copy of
  // the recipe's declared fields with the edits applied, owned by this org,
  // editable from then on and listed under "My templates".
  const saveAsMine = async () => {
    if (!template || !draft || saving) return
    if (!draftValid) { toast.error('A template needs a name and instructions.'); return }
    setSaving(true)
    try {
      const response = await fetch('/api/agent-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description.trim(),
          category: template.category || template.departments?.[0] || 'Custom',
          instructions: draft.instructions.trim(),
          integrations: template.integrations ?? [],
          skills: template.skills ?? [],
          tags: template.tags ?? [],
          model: draft.model,
          ...(template.exampleOutput && !template.seed ? { exampleOutput: template.exampleOutput } : {}),
          ...(template.icon ? { icon: template.icon } : {}),
          ...(template.allowSubagents ? { allowSubagents: true } : {}),
          ...(template.subagentIds?.length ? { subagentIds: template.subagentIds } : {}),
          ...(template.goal ? { goal: template.goal } : {}),
          ...(template.autoAnswerFromMemory === false ? { autoAnswerFromMemory: false } : {}),
          ...(template.alwaysStrategize ? { alwaysStrategize: true } : {}),
          ...(typeof template.maxTurns === 'number' ? { maxTurns: template.maxTurns } : {}),
          ...(template.outputFields?.length ? { outputFields: template.outputFields } : {}),
          schedule: persistedSchedule(draft.schedule),
          departments: template.departments ?? [],
          requiredIntegrations: template.requiredIntegrations ?? [],
          recommendedIntegrations: template.recommendedIntegrations ?? [],
          kind: template.kind ?? 'agent',
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.template?.id) throw new Error(data.error || 'Could not save this template.')
      invalidateCachedJson('/api/agent-templates')
      toast.success(data.updated ? 'Updated your existing template with that name.' : 'Saved to your templates.')
      router.push(`/templates/${data.template.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save this template.')
    } finally {
      setSaving(false)
    }
  }

  const deployBlocked = Boolean(deploying) || missing.length > 0 || (dirty && !draftValid)

  return (
    <>
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2 w-fit">
          <Link href="/agents?view=templates"><ArrowLeft className="mr-1.5 h-4 w-4" />Back to templates</Link>
        </Button>
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-9 w-2/3 rounded-lg" />
            <Skeleton className="h-5 w-full rounded" />
            <Skeleton className="h-64 rounded-lg" />
          </div>
        ) : loadError || !template || !draft ? (
          <div className="rounded-lg border bg-card p-6 text-center shadow-1">
            <h1 className="text-lg font-semibold">Could not open template</h1>
            <p className="mt-2 text-sm text-muted-foreground">{loadError || 'This template could not be found.'}</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="outline" asChild><Link href="/agents?view=templates">Back to templates</Link></Button>
              <Button onClick={() => setReloadKey((key) => key + 1)}>Try again</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex animate-fade-in-up flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                {editing ? (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="template-name">Name</Label>
                      <Input
                        id="template-name"
                        value={draft.name}
                        maxLength={MAX_OVERRIDE_NAME}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        className="text-lg font-semibold"
                      />
                    </div>
                    <div>
                      <Label htmlFor="template-description">Description</Label>
                      <Textarea
                        id="template-description"
                        rows={2}
                        maxLength={MAX_OVERRIDE_DESCRIPTION}
                        value={draft.description}
                        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-2xl font-bold">{draft.name}</h1>
                      {dirty && <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-indigo-700">Customized</Badge>}
                      {template.mine && <Badge variant="outline">Yours</Badge>}
                    </div>
                    <p className="mt-2 max-w-3xl text-muted-foreground">{draft.description}</p>
                  </>
                )}
              </div>
              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
                <div className="flex items-center gap-2">
                  <Label htmlFor="assign-worker" className="shrink-0 text-xs font-normal text-muted-foreground">
                    Agent joins
                  </Label>
                  <Select value={assignTo} onValueChange={setAssignTo}>
                    <SelectTrigger id="assign-worker" className="h-9 sm:w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SOLO}>Works alone</SelectItem>
                      {workers.map((worker) => (
                        <SelectItem key={worker.id} value={worker.id}>{worker.name}</SelectItem>
                      ))}
                      <SelectItem value={NEW_WORKER}>New worker…</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {assignTo === NEW_WORKER && (
                  <Input
                    value={newWorkerName}
                    maxLength={60}
                    onChange={(event) => setNewWorkerName(event.target.value)}
                    placeholder={`Name — defaults to ${draft.name || template.name}`}
                    aria-label="New worker name"
                    className="h-9 sm:w-56"
                  />
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="outline" onClick={() => connect('agent')} loading={deploying === 'agent'} disabled={deployBlocked}>
                    <Bot className="mr-1.5 h-4 w-4" />Connect to agent
                  </Button>
                  <Button onClick={() => connect('flow')} loading={deploying === 'flow'} disabled={deployBlocked}>
                    <Workflow className="mr-1.5 h-4 w-4" />Connect to flow
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  {editing ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={resetDraft} disabled={!dirty || saving}>
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />Reset
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>Done</Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />Customize
                    </Button>
                  )}
                  {template.mine ? (
                    <Button variant="secondary" size="sm" onClick={saveChanges} loading={saving} disabled={!dirty || saving}>
                      <Save className="mr-1.5 h-3.5 w-3.5" />Save changes
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={saveAsMine} loading={saving} disabled={saving}>
                      <Copy className="mr-1.5 h-3.5 w-3.5" />Save as my template
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {dirty && !editing && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
                Deploys with your edits to {customizedFields.join(', ')}. The template itself is unchanged
                {template.mine ? ' until you save.' : ' — save it as your own template to keep them.'}
              </div>
            )}

            {missing.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Connect {missing.join(', ')} to deploy this template — once connected, it deploys in one click with everything pre-configured.{' '}
                <Link href="/integrations" className="font-semibold underline underline-offset-2">Open integrations</Link>
              </div>
            )}

            {ambiguousProviders.length > 0 && (
              <div className="rounded-lg border bg-card px-4 py-3 text-sm shadow-1">
                <p className="font-medium">Choose which account to use</p>
                <div className="mt-2 flex flex-wrap gap-4">
                  {ambiguousProviders.map(({ provider, matches }) => (
                    <label key={provider} className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span className="capitalize">{provider}:</span>
                      <select
                        className="rounded-md border bg-background px-2 py-1 text-sm"
                        value={accountChoices[bindSlug(provider)] ?? matches[0].id}
                        onChange={(event) =>
                          setAccountChoices((prev) => ({ ...prev, [bindSlug(provider)]: event.target.value }))
                        }
                      >
                        {matches.map((match) => (
                          <option key={match.id} value={match.id}>{match.name} ({match.id})</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
              <section className="rounded-xl border bg-card p-5 shadow-1">
                <div className="mb-3 flex items-center justify-between">
                  <p className="eyebrow">Agent instructions</p>
                  {!editing && (
                    <button type="button" onClick={() => setEditing(true)} className="text-xs font-medium text-indigo-600 hover:underline">
                      Edit
                    </button>
                  )}
                </div>
                {editing ? (
                  <>
                    <Textarea
                      id="template-instructions"
                      aria-label="Agent instructions"
                      value={draft.instructions}
                      maxLength={MAX_OVERRIDE_INSTRUCTIONS}
                      onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                      className="min-h-[520px] font-mono text-sm leading-relaxed"
                    />
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Rewrite freely — tone, steps, what to include, what to skip. The output standard is appended automatically on deploy.
                    </p>
                  </>
                ) : (
                  <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">{draft.instructions}</pre>
                )}
              </section>
              <section className="rounded-xl border bg-card p-5 shadow-1">
                <p className="eyebrow mb-3">Output example</p>
                <HtmlPreview html={exampleHtml(template)} />
                <p className="mt-1.5 text-xs text-muted-foreground">Illustrative — actual output uses your connected tools and live data.</p>
              </section>
            </div>

            <div className="grid gap-5 rounded-xl border bg-card p-5 shadow-1 md:grid-cols-3">
              <div className={editing ? 'md:col-span-2' : undefined}>
                <p className="eyebrow mb-2">Automation</p>
                {editing ? (
                  <TemplateSchedulePicker
                    value={draft.schedule}
                    onChange={(schedule) => setDraft({ ...draft, schedule })}
                    timezone={viewerTimeZone}
                  />
                ) : (
                  <div className="flex items-start gap-2 text-sm text-muted-foreground">
                    <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                    <span>{scheduleLabel(draft.schedule, viewerTimeZone)}</span>
                  </div>
                )}
              </div>

              <div>
                <p className="eyebrow mb-2">Model</p>
                {editing ? (
                  <Select value={draft.model} onValueChange={(model) => setDraft({ ...draft, model })}>
                    <SelectTrigger id="template-model" aria-label="Model" className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {modelOptions.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-muted-foreground">{modelLabel(draft.model)}</p>
                )}
              </div>

              {/* Catalogue templates distinguish must-have from nice-to-have
                  integrations — mirror the card's "Requires" list instead of
                  mixing both into one. Templates without that metadata keep
                  the combined list. */}
              {(template.requiredIntegrations?.length || template.recommendedIntegrations?.length) ? (
                <div className="space-y-4">
                  {!!template.requiredIntegrations?.length && (
                    <div>
                      <p className="eyebrow mb-2">Requires</p>
                      <div className="flex flex-wrap gap-2">
                        {template.requiredIntegrations.map((integration) => <IntegrationChip key={integration} name={integration} />)}
                      </div>
                    </div>
                  )}
                  {!!template.recommendedIntegrations?.length && (
                    <div>
                      <p className="eyebrow mb-2">Recommended</p>
                      <div className="flex flex-wrap gap-2">
                        {template.recommendedIntegrations.map((integration) => <IntegrationChip key={integration} name={integration} />)}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <p className="eyebrow mb-2">Requires</p>
                  <div className="flex flex-wrap gap-2">
                    {template.integrations.map((integration) => <IntegrationChip key={integration} name={integration} />)}
                  </div>
                </div>
              )}

              <div>
                <p className="eyebrow mb-2">Departments</p>
                <p className="text-sm capitalize text-muted-foreground">{template.departments?.join(', ') || 'Cross-functional'}</p>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
