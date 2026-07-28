'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Bot, CalendarClock, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { HtmlPreview, looksLikeHtml } from '@/components/ui/html-preview'
import { missingIntegrations, connectedSlugSet } from '@/lib/templates/relevance'
import { findTemplateForRoute } from '@/lib/templates/route-id'
import { exampleArtifactHtml } from '@/lib/templates/example-artifact'
import { getCachedJson } from '@/lib/client/use-cached-json'
import { describeSchedule } from '@/lib/scheduling/describe-schedule'
import { useViewerTimeZone } from '@/lib/scheduling/use-viewer-time-zone'

type Template = {
  id: string
  name: string
  description: string
  instructions: string
  integrations: string[]
  skills?: string[]
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
  schedule?: typeof MANUAL_SCHEDULE
  // Seed-catalogue metadata (additive; absent on legacy DB-authored templates).
  kind?: 'agent' | 'flow'
  seed?: boolean
  seedKey?: string
  requiredIntegrations?: string[]
  recommendedIntegrations?: string[]
  departments?: string[]
  trigger?: {
    type?: string
    schedule?: { type?: string; cron?: string; time?: string; timezone?: string; isActive?: boolean }
  }
}

type ProvisionKind = 'agent' | 'flow'

type CatalogConnection = { id: string; name: string }

/** Same normalization the server's binding pass uses (provision-plan.ts). */
const bindSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

const MANUAL_SCHEDULE = { type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false }

function templateSchedule(template: Template) {
  const schedule = template.trigger?.type === 'schedule' ? template.trigger.schedule : undefined
  return schedule
    ? {
        type: schedule.type || 'cron',
        time: schedule.time || '',
        cron: schedule.cron || '',
        timezone: schedule.timezone || 'UTC',
        isActive: schedule.isActive !== false,
      }
    : template.schedule ?? MANUAL_SCHEDULE
}

function scheduleLabel(template: Template, viewerTimeZone: string): string {
  const schedule = templateSchedule(template)
  if (!schedule.isActive || schedule.type === 'manual') return 'Run manually or add a schedule after connecting'
  return describeSchedule(schedule, viewerTimeZone, new Date())
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

export default function TemplateDetails() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [template, setTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [deploying, setDeploying] = useState<ProvisionKind | null>(null)
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
    getCachedJson<any>('/api/flows/tool-catalog', 30_000)
      .then((data) => setCatalog(Array.isArray(data.connections) ? data.connections : []))
      .catch(() => setCatalog([]))
  }, [])

  const missing = template ? missingIntegrations(template.requiredIntegrations ?? [], connected) : []

  // Providers where the workspace has SEVERAL satisfying connections — the
  // only case where "which account?" is a real question. Single-account
  // providers bind deterministically server-side with no UI.
  const ambiguousProviders = (template?.requiredIntegrations ?? [])
    .map((provider) => ({ provider, matches: catalog.filter((c) => bindSlug(c.name) === bindSlug(provider)) }))
    .filter((entry) => entry.matches.length > 1)

  // Every template — seed or community — deploys through the trusted
  // server-side provision route: instructions, schedule, and connection
  // bindings are resolved there, never assembled client-side.
  const connect = async (targetKind: ProvisionKind) => {
    if (!template || deploying) return
    setDeploying(targetKind)
    try {
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
        ) : loadError || !template ? (
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
              <div>
                <h1 className="text-2xl font-bold">{template.name}</h1>
                <p className="mt-2 max-w-3xl text-muted-foreground">{template.description}</p>
              </div>
              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
                <Button variant="outline" onClick={() => connect('agent')} loading={deploying === 'agent'} disabled={Boolean(deploying) || missing.length > 0}>
                  <Bot className="mr-1.5 h-4 w-4" />Connect to agent
                </Button>
                <Button onClick={() => connect('flow')} loading={deploying === 'flow'} disabled={Boolean(deploying) || missing.length > 0}>
                  <Workflow className="mr-1.5 h-4 w-4" />Connect to flow
                </Button>
              </div>
            </div>

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
                <p className="eyebrow mb-3">Agent instructions</p>
                <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">{template.instructions}</pre>
              </section>
              <section className="rounded-xl border bg-card p-5 shadow-1">
                <p className="eyebrow mb-3">Output example</p>
                <HtmlPreview html={exampleHtml(template)} />
                <p className="mt-1.5 text-xs text-muted-foreground">Illustrative — actual output uses your connected tools and live data.</p>
              </section>
            </div>

            <div className="grid gap-5 rounded-xl border bg-card p-5 shadow-1 md:grid-cols-3">
              <div>
                <p className="eyebrow mb-2">Automation</p>
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                  <span>{scheduleLabel(template, viewerTimeZone)}</span>
                </div>
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
