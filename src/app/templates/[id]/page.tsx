'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { missingIntegrations, connectedSlugSet } from '@/lib/templates/relevance'

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
}

export default function TemplateDetails() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [template, setTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [connected, setConnected] = useState<Set<string>>(new Set())

  useEffect(() => {
    setLoading(true)
    setLoadError('')
    fetch('/api/agent-templates', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Could not load templates.')
        const match = (data.templates || []).find((item: Template) => item.id === id)
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

  const createAgent = async () => {
    if (!template) return
    setCreating(true)
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
        schedule: { type: 'manual', timezone: 'UTC', isActive: false },
      }),
    })
    setCreating(false)
    if (response.ok) router.push('/dashboard')
  }

  // Seed templates provision via the catalogue endpoint (materializes agents +
  // a wired Flow, or a single agent). Legacy non-seed templates keep the
  // existing createAgent path.
  const provision = async () => {
    if (!template?.seed) return createAgent()
    setDeploying(true)
    const response = await fetch('/api/templates/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seedKey: template.seedKey }),
    })
    const data = await response.json().catch(() => ({}))
    setDeploying(false)
    if (response.ok && data.kind === 'flow' && data.flowId) router.push(`/flows/${data.flowId}`)
    else if (response.ok && data.kind === 'agent' && data.agentId) router.push('/dashboard')
  }

  return (
    <>
      <div className="mx-auto max-w-3xl space-y-5 p-6">
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
            <div className="flex animate-fade-in-up items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold">{template.name}</h1>
                <p className="mt-2 text-gray-600">{template.description}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {missing.length > 0 ? (
                  <Button asChild>
                    <Link href="/integrations">Connect to use</Link>
                  </Button>
                ) : (
                  <Button onClick={provision} loading={creating || deploying}>
                    {creating || deploying
                      ? 'Creating…'
                      : template.seed
                        ? template.kind === 'flow' ? 'Use template' : 'Create agent'
                        : 'Use template'}
                  </Button>
                )}
              </div>
            </div>
            <pre className="whitespace-pre-wrap rounded-lg border bg-gray-50 p-4 text-sm shadow-1">{template.instructions}</pre>

            {template.exampleOutput && (
              <div>
                <p className="eyebrow mb-2">Example output</p>
                <div className="rounded-lg border border-horizon-200 bg-horizon-50/40 p-4 shadow-1">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{template.exampleOutput}</p>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">Illustrative — actual output uses your live data.</p>
              </div>
            )}

            {template.integrations.length > 0 && (
              <div>
                <p className="eyebrow mb-2">Requires</p>
                <div className="flex flex-wrap gap-2">
                  {template.integrations.map((integration) => <IntegrationChip key={integration} name={integration} />)}
                </div>
                {missing.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Missing: {missing.join(', ')}
                  </p>
                )}
              </div>
            )}

            {template.departments && template.departments.length > 0 && (
              <div>
                <p className="eyebrow mb-2">Departments</p>
                <p className="text-sm text-gray-600">{template.departments.join(', ')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
