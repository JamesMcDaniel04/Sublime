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
  // Seed-catalogue metadata (additive; absent on legacy DB-authored templates).
  kind?: 'agent' | 'flow'
  seed?: boolean
  seedKey?: string
  requiredIntegrations?: string[]
  departments?: string[]
  trigger?: {
    type?: string
    schedule?: { type?: string; cron?: string; time?: string; timezone?: string; isActive?: boolean }
  }
}

type ProvisionKind = 'agent' | 'flow'

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
    : MANUAL_SCHEDULE
}

function scheduleLabel(template: Template): string {
  const schedule = templateSchedule(template)
  if (!schedule.isActive || schedule.type === 'manual') return 'Run manually or add a schedule after connecting'
  if (schedule.type === 'cron' && schedule.cron === '0 14 * * 1') return `Every Monday at 14:00 (${schedule.timezone})`
  if (schedule.type === 'cron') return `Scheduled with cron ${schedule.cron} (${schedule.timezone})`
  return `${schedule.type.charAt(0).toUpperCase()}${schedule.type.slice(1)} (${schedule.timezone})`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function exampleHtml(template: Template): string {
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

  useEffect(() => {
    setLoading(true)
    setLoadError('')
    fetch('/api/agent-templates', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Could not load templates.')
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
    fetch('/api/integrations/available', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setConnected(connectedSlugSet(data.tools || [])))
      .catch(() => setConnected(new Set()))
  }, [])

  const missing = template ? missingIntegrations(template.requiredIntegrations ?? [], connected) : []

  const createLegacyAgent = async (): Promise<string> => {
    if (!template) throw new Error('Template is not loaded.')
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: template.name,
        description: template.description,
        instructions: template.instructions,
        integrations: template.integrations,
        skills: template.skills || [],
        model: template.model,
        icon: template.icon || '',
        allowSubagents: template.allowSubagents === true,
        schedule: templateSchedule(template),
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.agent?.id) throw new Error(data.error || 'Could not create the agent.')
    return data.agent.id as string
  }

  const connect = async (targetKind: ProvisionKind) => {
    if (!template || deploying) return
    setDeploying(targetKind)
    try {
      if (template.seed) {
        const response = await fetch('/api/templates/provision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seedKey: template.seedKey, targetKind }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `Could not connect this template to a ${targetKind}.`)
        if (targetKind === 'flow' && data.flowId) router.push(`/flows/${data.flowId}`)
        else if (targetKind === 'agent' && data.agentId) router.push('/dashboard')
        return
      }

      // Community templates do not have a trusted server-side graph. Create
      // their agent first, then wrap it in the same trigger -> agent graph when
      // the user selects the Flow path.
      const agentId = await createLegacyAgent()
      if (targetKind === 'agent') {
        router.push('/dashboard')
        return
      }
      const trigger = template.trigger ?? { type: 'manual' }
      const response = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          status: 'DRAFT',
          trigger,
          graph: {
            nodes: [
              { id: 'trigger', type: 'trigger', data: { trigger } },
              { id: 'run-agent', type: 'agent', data: { agentId, label: template.name, input: '{{trigger.input}}' } },
            ],
            edges: [{ id: 'trigger-run-agent', source: 'trigger', target: 'run-agent' }],
          },
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.flow?.id) throw new Error(data.error || 'Could not create the flow.')
      router.push(`/flows/${data.flow.id}`)
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
          <Link href="/templates"><ArrowLeft className="mr-1.5 h-4 w-4" />Back to templates</Link>
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
              <Button variant="outline" asChild><Link href="/templates">Back to templates</Link></Button>
              <Button onClick={() => setReloadKey((key) => key + 1)}>Try again</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex animate-fade-in-up flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h1 className="text-2xl font-bold">{template.name}</h1>
                <p className="mt-2 max-w-3xl text-gray-600">{template.description}</p>
              </div>
              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
                <Button variant="outline" onClick={() => connect('agent')} loading={deploying === 'agent'} disabled={Boolean(deploying)}>
                  <Bot className="mr-1.5 h-4 w-4" />Connect to agent
                </Button>
                <Button onClick={() => connect('flow')} loading={deploying === 'flow'} disabled={Boolean(deploying)}>
                  <Workflow className="mr-1.5 h-4 w-4" />Connect to flow
                </Button>
              </div>
            </div>

            {missing.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                This template will be created now, but {missing.join(', ')} still {missing.length === 1 ? 'needs' : 'need'} to be connected before every step can run.{' '}
                <Link href="/integrations" className="font-semibold underline underline-offset-2">Open integrations</Link>
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
                <div className="flex items-start gap-2 text-sm text-gray-700">
                  <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                  <span>{scheduleLabel(template)}</span>
                </div>
              </div>

              <div>
                <p className="eyebrow mb-2">Requires</p>
                <div className="flex flex-wrap gap-2">
                  {template.integrations.map((integration) => <IntegrationChip key={integration} name={integration} />)}
                </div>
              </div>

              <div>
                <p className="eyebrow mb-2">Departments</p>
                <p className="text-sm capitalize text-gray-600">{template.departments?.join(', ') || 'Cross-functional'}</p>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
