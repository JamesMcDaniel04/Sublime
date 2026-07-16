'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, BookOpen, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { decodeSkillRouteId } from '@/lib/skills/route-id'
import { invalidateCachedJson } from '@/lib/client/use-cached-json'

type Skill = {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations?: string[]
  instructions: string
  mine?: boolean
}

/** Edit dialog draft — comma-separated inputs mirror the explorer's asset dialog. */
type SkillDraft = {
  name: string
  category: string
  description: string
  instructions: string
  tags: string
  integrations: string
}

const csv = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean)

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
  const router = useRouter()
  const skillId = decodeSkillRouteId(id)
  const [skill, setSkill] = useState<Skill | null>(null)
  const [templates, setTemplates] = useState<SuggestedTemplate[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  // Owner-only actions (skill.mine): edit dialog + themed delete confirmation.
  const [editDraft, setEditDraft] = useState<SkillDraft | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

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

  const openEdit = () => {
    if (!skill) return
    setEditDraft({
      name: skill.name,
      category: skill.category,
      description: skill.description,
      instructions: skill.instructions,
      tags: skill.tags.join(', '),
      integrations: (skill.integrations ?? []).join(', '),
    })
  }

  const saveEdit = async () => {
    if (!skill || !editDraft) return
    if (!editDraft.name.trim() || !editDraft.instructions.trim()) {
      toast.error('Name and instructions are required.')
      return
    }
    setSavingEdit(true)
    try {
      const response = await fetch('/api/skills', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: skill.id,
          name: editDraft.name,
          category: editDraft.category,
          description: editDraft.description,
          instructions: editDraft.instructions,
          tags: csv(editDraft.tags),
          integrations: csv(editDraft.integrations),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save the skill.')
      setSkill((current) => current ? { ...current, ...data.skill } : current)
      // The explorer caches /api/skills — invalidate so the list reflects the edit.
      invalidateCachedJson('/api/skills')
      toast.success('Saved')
      setEditDraft(null)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not save the skill.')
    } finally {
      setSavingEdit(false)
    }
  }

  const deleteSkill = async () => {
    if (!skill || deleting) return
    setDeleting(true)
    try {
      const response = await fetch('/api/skills', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skill.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not remove the skill.')
      invalidateCachedJson('/api/skills')
      toast.success('Removed')
      router.push('/dashboard?view=templates&tab=skills')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not remove the skill.')
      setDeleting(false)
      setConfirmingDelete(false)
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
              {skill.mine && (
                <div className="mt-4 flex gap-2">
                  <Button variant="outline" size="sm" onClick={openEdit}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" />Edit
                  </Button>
                  <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700" onClick={() => setConfirmingDelete(true)}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete
                  </Button>
                </div>
              )}
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

          <Dialog open={editDraft !== null} onOpenChange={(open) => !open && setEditDraft(null)}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Edit skill</DialogTitle>
              </DialogHeader>
              {editDraft && (
                <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
                      <Input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
                      <Input value={editDraft.category} onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })} />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
                    <Input value={editDraft.description} onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })} placeholder="One line shown on the card" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Skill instructions (composed into the agent prompt)</label>
                    <Textarea rows={8} value={editDraft.instructions} onChange={(e) => setEditDraft({ ...editDraft, instructions: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Tags (comma-separated)</label>
                      <Input value={editDraft.tags} onChange={(e) => setEditDraft({ ...editDraft, tags: e.target.value })} placeholder="sales, email" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Integrations (comma-separated)</label>
                      <Input value={editDraft.integrations} onChange={(e) => setEditDraft({ ...editDraft, integrations: e.target.value })} placeholder="Slack, Sublime MCP" />
                    </div>
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditDraft(null)}>Cancel</Button>
                <Button onClick={saveEdit} loading={savingEdit}>Save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={confirmingDelete} onOpenChange={(open) => !open && !deleting && setConfirmingDelete(false)}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Remove skill</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                Remove &quot;{skill.name}&quot; from the community library? Agents referencing it simply stop composing it.
              </p>
              <DialogFooter>
                <Button variant="outline" disabled={deleting} onClick={() => setConfirmingDelete(false)}>Cancel</Button>
                <Button variant="destructive" onClick={deleteSkill} loading={deleting}>Remove</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}
