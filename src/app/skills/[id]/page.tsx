'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, BookOpen, Plus, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { decodeSkillRouteId } from '@/lib/skills/route-id'

type Skill = {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  instructions: string
}

type SuggestedTemplate = {
  id: string
  name: string
  description: string
  departments?: string[]
  requiredIntegrations?: string[]
}

type Agent = { id: string; title: string; skills: string[] }

export default function SkillDetailsPage() {
  const { id } = useParams<{ id: string }>()
  const skillId = decodeSkillRouteId(id)
  const [skill, setSkill] = useState<Skill | null>(null)
  const [templates, setTemplates] = useState<SuggestedTemplate[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/skills/${encodeURIComponent(skillId)}`, { cache: 'no-store' }),
      fetch('/api/agents', { cache: 'no-store' }),
    ])
      .then(async ([skillResponse, agentsResponse]) => {
        const skillData = await skillResponse.json().catch(() => ({}))
        const agentsData = await agentsResponse.json().catch(() => ({}))
        if (!skillResponse.ok) throw new Error(skillData.error || 'Could not load this skill.')
        if (cancelled) return
        setSkill(skillData.skill)
        setTemplates(skillData.templates || [])
        const nextAgents = agentsResponse.ok ? agentsData.agents || [] : []
        setAgents(nextAgents)
        setSelectedAgentId(nextAgents[0]?.id || '')
      })
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : 'Could not load this skill.'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [skillId])

  const addToAgent = async () => {
    if (!skill || !selectedAgentId || adding) return
    const agent = agents.find((candidate) => candidate.id === selectedAgentId)
    if (!agent) return
    if (agent.skills.includes(skill.id)) {
      toast(`${skill.name} is already attached to ${agent.title}.`)
      return
    }
    setAdding(true)
    try {
      const skills = [...agent.skills, skill.id]
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: skill.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not attach the skill.')
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, skills } : item))
      toast.success(`Added ${skill.name} to ${agent.title}.`)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not attach the skill.')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 w-fit">
        <Link href="/dashboard?view=templates&tab=skills"><ArrowLeft className="mr-1.5 h-4 w-4" />Back to skills</Link>
      </Button>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : error || !skill ? (
        <div className="rounded-xl border bg-card p-8 text-center">
          <h1 className="text-lg font-semibold">Could not open skill</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error || 'This skill could not be found.'}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge variant="outline">{skill.category}</Badge>
                {skill.tags.slice(0, 3).map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
              </div>
              <h1 className="text-3xl font-bold tracking-tight">{skill.name}</h1>
              <p className="mt-3 text-base leading-relaxed text-muted-foreground">{skill.description}</p>
            </div>

            <div className="w-full rounded-xl border bg-card p-4 shadow-1 lg:w-[360px]">
              <p className="text-sm font-semibold">Add this enhancer to an agent</p>
              <p className="mt-1 text-xs text-muted-foreground">The instructions are composed into every run. No tool connection is required.</p>
              {agents.length ? (
                <div className="mt-3 flex gap-2">
                  <select
                    value={selectedAgentId}
                    onChange={(event) => setSelectedAgentId(event.target.value)}
                    className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
                  </select>
                  <Button onClick={addToAgent} loading={adding}><Plus className="mr-1 h-4 w-4" />Add</Button>
                </div>
              ) : (
                <Button asChild variant="outline" className="mt-3 w-full"><Link href="/dashboard">Create an agent first</Link></Button>
              )}
            </div>
          </div>

          <section className="rounded-xl border bg-card p-6 shadow-1">
            <div className="mb-4 flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-indigo-600" />
              <h2 className="text-lg font-semibold">Skill instructions</h2>
            </div>
            <div className="rounded-lg border bg-muted/30 p-5">
              <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">{skill.instructions}</p>
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-indigo-600" />
                <h2 className="text-lg font-semibold">Templates improved by this skill</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Use these as starting points, then attach the skill to the template's agent for more consistent results.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {templates.map((template) => (
                <Link key={template.id} href={`/templates/${template.id}`} className="block h-full">
                  <Card className="h-full transition-all hover:-translate-y-0.5 hover:shadow-md">
                    <CardHeader className="pb-2">
                      <Badge variant="outline" className="w-fit capitalize">{template.departments?.[0] || 'Cross-functional'}</Badge>
                      <CardTitle className="text-base leading-snug">{template.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="line-clamp-4 text-sm text-muted-foreground">{template.description}</p>
                      {!!template.requiredIntegrations?.length && (
                        <div className="flex flex-wrap gap-1.5">
                          {template.requiredIntegrations.slice(0, 2).map((name) => <IntegrationChip key={name} name={name} />)}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
