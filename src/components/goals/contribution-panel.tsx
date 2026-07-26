'use client'

import { useEffect, useState } from 'react'
import { Bot, Pencil, Plus, Unlink, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type Contribution = {
  id: string
  resourceType: 'flow' | 'agent'
  resourceId: string
  name: string
  origin: 'suggestion' | 'manual'
  estimatedMinutesSavedPerRun: number
  runs: number
  tokens: number
  avgRunSeconds: number | null
  calibratedFromTeams: number | null
  createdAt: string
}

type Resource = { id: string; name: string; type: 'flow' | 'agent' }

export function ContributionPanel({
  goalId,
  contributions,
  onChanged,
}: {
  readonly goalId: string
  readonly contributions: Contribution[]
  readonly onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [resources, setResources] = useState<Resource[]>([])
  const [resourceKey, setResourceKey] = useState('')
  const [minutes, setMinutes] = useState('30')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    Promise.all([
      fetch('/api/flows', { cache: 'no-store' }).then((response) => response.json()),
      fetch('/api/agents', { cache: 'no-store' }).then((response) => response.json()),
    ])
      .then(([flowBody, agentBody]) => {
        const flows = (flowBody.flows ?? []).map((flow: { id: string; name: string }) => ({
          id: flow.id,
          name: flow.name,
          type: 'flow' as const,
        }))
        const agents = (agentBody.agents ?? []).map(
          (agent: { id: string; title?: string; description?: string }) => ({
            id: agent.id,
            name: agent.title || agent.description || 'Untitled agent',
            type: 'agent' as const,
          }),
        )
        const linked = new Set(
          contributions.map(
            (contribution) => `${contribution.resourceType}:${contribution.resourceId}`,
          ),
        )
        setResources(
          [...flows, ...agents].filter(
            (resource) => !linked.has(`${resource.type}:${resource.id}`),
          ),
        )
      })
      .catch(() => toast.error('Could not load automations.'))
  }, [contributions, open])

  const link = async () => {
    const resource = resources.find(
      (candidate) => `${candidate.type}:${candidate.id}` === resourceKey,
    )
    if (!resource) return toast.error('Choose an automation.')
    setSaving(true)
    try {
      const response = await fetch(`/api/goals/${goalId}/contributions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceType: resource.type,
          resourceId: resource.id,
          estimatedMinutesSavedPerRun: Number(minutes),
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not link automation.')
      await onChanged()
      setOpen(false)
      setResourceKey('')
      toast.success('Automation linked to this goal.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not link automation.')
    } finally {
      setSaving(false)
    }
  }

  const unlink = async (id: string) => {
    const response = await fetch(
      `/api/goals/${goalId}/contributions?contributionId=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
    const body = await response.json()
    if (!response.ok) return toast.error(body.error || 'Could not unlink automation.')
    await onChanged()
    toast.success('Automation unlinked.')
  }

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Contributing automations</h2>
          <p className="text-sm text-muted-foreground">
            Attribution starts when an automation is linked. Earlier runs never count.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              Link automation
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Link an automation</DialogTitle></DialogHeader>
            <label className="space-y-1.5 text-sm">
              <span>Flow or agent</span>
              <Select value={resourceKey} onValueChange={setResourceKey}>
                <SelectTrigger><SelectValue placeholder="Choose automation" /></SelectTrigger>
                <SelectContent>
                  {resources.map((resource) => (
                    <SelectItem
                      key={`${resource.type}:${resource.id}`}
                      value={`${resource.type}:${resource.id}`}
                    >
                      {resource.type === 'flow' ? 'Flow' : 'Agent'} · {resource.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span>Estimated manual minutes replaced per run</span>
              <Input
                type="number"
                min="1"
                max="480"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
            </label>
            <DialogFooter>
              <Button onClick={link} disabled={saving || !resourceKey}>
                {saving ? 'Linking…' : 'Link'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {contributions.length === 0 ? (
        <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
          No automation is linked yet. Link one to start the day-one proof trail.
        </p>
      ) : (
        <div className="divide-y">
          {contributions.map((contribution) => {
            const Icon = contribution.resourceType === 'flow' ? Workflow : Bot
            return (
              <div key={contribution.id} className="flex items-center gap-3 py-3">
                <span className="rounded-lg bg-muted p-2">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{contribution.name}</p>
                    <Badge variant="outline">
                      {contribution.origin === 'suggestion' ? 'Suggested' : 'Linked'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {contribution.runs} completed runs ·{' '}
                    {contribution.avgRunSeconds === null
                      ? 'no measured AI time yet'
                      : `${formatDuration(contribution.avgRunSeconds)} avg AI time / run`}
                  </p>
                  {contribution.calibratedFromTeams && (
                    <p className="text-xs text-muted-foreground">
                      Estimate calibrated from {contribution.calibratedFromTeams} teams
                    </p>
                  )}
                </div>
                <EstimateEditor goalId={goalId} contribution={contribution} onChanged={onChanged} />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Unlink ${contribution.name}`}
                  onClick={() => void unlink(contribution.id)}
                >
                  <Unlink className="h-4 w-4" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function EstimateEditor({
  goalId,
  contribution,
  onChanged,
}: {
  readonly goalId: string
  readonly contribution: Contribution
  readonly onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [minutes, setMinutes] = useState(String(contribution.estimatedMinutesSavedPerRun))
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (saving) return
    const value = Number(minutes)
    if (!Number.isInteger(value) || value < 1 || value > 480) {
      toast.error('Enter an estimate from 1 to 480 minutes.')
      return
    }
    if (value === contribution.estimatedMinutesSavedPerRun) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      const response = await fetch(`/api/goals/${goalId}/contributions`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contributionId: contribution.id,
          estimatedMinutesSavedPerRun: value,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not update the estimate.')
      await onChanged()
      setEditing(false)
      toast.success('Time estimate updated.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the estimate.')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setEditing(true)}
        aria-label={`Edit time estimate for ${contribution.name}`}
      >
        {contribution.estimatedMinutesSavedPerRun} min
        <Pencil className="ml-1.5 h-3.5 w-3.5" />
      </Button>
    )
  }

  return (
    <Input
      className="w-24"
      type="number"
      min="1"
      max="480"
      autoFocus
      value={minutes}
      disabled={saving}
      aria-label={`Estimated manual minutes replaced by ${contribution.name}`}
      onChange={(event) => setMinutes(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          setMinutes(String(contribution.estimatedMinutesSavedPerRun))
          setEditing(false)
        }
      }}
    />
  )
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`
}
