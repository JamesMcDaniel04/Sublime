'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { ScopedLink as Link } from '@/components/ui/scoped-link'
import { ArrowLeft, Check, Copy, Sparkles, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { HtmlPreview } from '@/components/ui/html-preview'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { STARTER_TEMPLATES } from '@/lib/flows/starter-templates'
import { connectedSlugSet, missingIntegrations } from '@/lib/templates/relevance'
import { getCachedJson, invalidateCachedJson } from '@/lib/client/use-cached-json'

type AvailableTool = { key?: string; label?: string; slug?: string; connected: boolean }

export default function FlowTemplateDetailsPage() {
  const { key } = useParams<{ key: string }>()
  const router = useScopedRouter()
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const template = useMemo(() => STARTER_TEMPLATES.find((candidate) => candidate.key === key) ?? null, [key])

  useEffect(() => {
    getCachedJson<{ tools?: AvailableTool[] }>('/api/integrations/available', 30_000)
      .then((data) => setConnected(connectedSlugSet(data.tools ?? [])))
      .catch(() => setConnected(new Set()))
  }, [])

  const missing = template ? missingIntegrations(template.requires, connected) : []
  const steps = template?.graph.nodes
    .filter((node) => node.type !== 'trigger')
    .map((node) => ({
      id: node.id,
      type: node.type,
      label: (node.data as { label?: string }).label || node.type.charAt(0).toUpperCase() + node.type.slice(1),
    })) ?? []

  const copyInstructions = async () => {
    if (!template) return
    try {
      await navigator.clipboard.writeText(template.copilotInstructions)
      setCopied(true)
      toast.success('Copilot instructions copied.')
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('Could not copy the instructions.')
    }
  }

  const createFlow = async () => {
    if (!template || creating) return
    setCreating(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          trigger: template.trigger,
          graph: template.graph,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.flow?.id) throw new Error(data.error || 'Could not create this flow.')
      invalidateCachedJson('/api/flows')
      router.push(`/flows/${data.flow.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create this flow.')
    } finally {
      setCreating(false)
    }
  }

  if (!template) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6 text-center">
        <h1 className="text-xl font-semibold">Flow template not found</h1>
        <p className="text-sm text-muted-foreground">This starter may have moved or is no longer available.</p>
        <Button variant="outline" asChild><Link href="/flows">Back to flows</Link></Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 w-fit">
        <Link href="/flows"><ArrowLeft className="mr-1.5 h-4 w-4" />Back to flows</Link>
      </Button>

      <header className="flex animate-fade-in-up flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="mb-3 flex items-center gap-2">
            <Badge variant="outline">{template.category}</Badge>
            <Badge variant="outline"><Workflow className="mr-1 h-3 w-3" />Flow template</Badge>
          </div>
          <h1 className="text-2xl font-bold">{template.name}</h1>
          <p className="mt-2 text-muted-foreground">{template.description}</p>
        </div>
        <Button onClick={createFlow} loading={creating} className="shrink-0">
          <Workflow className="mr-1.5 h-4 w-4" />Use this template
        </Button>
      </header>

      {missing.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          You can create this flow now, but {missing.join(', ')} still {missing.length === 1 ? 'needs' : 'need'} to be connected before every step can run.{' '}
          <Link href="/integrations" className="font-semibold underline underline-offset-2">Open integrations</Link>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <section className="overflow-hidden rounded-xl border bg-card shadow-1">
          <div className="border-b px-5 py-4">
            <p className="eyebrow">Detailed output</p>
            <h2 className="mt-1 text-base font-semibold">What this flow produces</h2>
          </div>
          <div className="p-5">
            <HtmlPreview html={template.exampleOutput} />
            <p className="mt-2 text-xs text-muted-foreground">Illustrative — live output uses your inputs and connected company data.</p>
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border bg-card shadow-1">
          <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
            <div>
              <p className="eyebrow">Copilot instructions</p>
              <h2 className="mt-1 text-base font-semibold">Build or customize it with Copilot</h2>
            </div>
            <Button size="sm" variant="outline" onClick={copyInstructions}>
              {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="p-5">
            <div className="mb-4 flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              Paste this brief into Flow Copilot to recreate the template or ask Copilot to adapt it to your process.
            </div>
            <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">{template.copilotInstructions}</pre>
          </div>
        </section>
      </div>

      <section className="rounded-xl border bg-card p-5 shadow-1">
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <p className="eyebrow mb-3">Company tools</p>
            <div className="flex flex-wrap gap-2">
              {template.requires.map((integration) => <IntegrationChip key={integration} name={integration} />)}
            </div>
          </div>
          <div>
            <p className="eyebrow mb-3">Flow steps</p>
            <ol className="grid gap-2 sm:grid-cols-2">
              {steps.map((step, index) => (
                <li key={step.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">{index + 1}</span>
                  <span className="min-w-0 truncate">{step.label}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">{step.type}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>
    </div>
  )
}
