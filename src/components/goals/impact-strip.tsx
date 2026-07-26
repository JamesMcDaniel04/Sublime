'use client'

import { useState } from 'react'
import { Bot, Clock3, DollarSign, TrendingUp } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { StatTile } from '@/components/ui/stat-tile'

export type OrgImpact = {
  measured: { runsCompleted: number; tokens: number }
  estimated: {
    hoursSaved: number
    laborValueUsd: number
    aiCostUsd: number
    roiMultiple: number | null
    hourlyRateUsd: number
  }
  correlated: { paceDeltaPct: number | null }
  goalsTracked: number
  contributionsLinked: number
}

export function ImpactStrip({
  impact,
  onSaved,
}: {
  readonly impact: OrgImpact
  readonly onSaved: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hourlyRate, setHourlyRate] = useState(String(impact.estimated.hourlyRateUsd))
  const [aiCost, setAiCost] = useState(
    impact.measured.tokens > 0
      ? String(
          (impact.estimated.aiCostUsd / (impact.measured.tokens / 1_000_000)).toFixed(2),
        )
      : '10',
  )

  const save = async () => {
    setSaving(true)
    try {
      const response = await fetch('/api/goals/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          laborHourlyRate: Number(hourlyRate),
          aiCostPerMTokensUsd: Number(aiCost),
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not save impact assumptions.')
      await onSaved()
      setOpen(false)
      toast.success('Impact assumptions updated.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save impact assumptions.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-2" aria-labelledby="impact-heading">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="impact-heading" className="text-lg font-semibold">
            AI impact
          </h2>
          <p className="text-xs text-muted-foreground">
            Measured activity, honest estimates, and correlated goal movement.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm">
              Edit assumptions
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Impact assumptions</DialogTitle>
            </DialogHeader>
            <label className="space-y-1.5 text-sm">
              <span>Labor value per hour</span>
              <Input
                type="number"
                min="1"
                max="10000"
                value={hourlyRate}
                onChange={(event) => setHourlyRate(event.target.value)}
              />
            </label>
            <label className="space-y-1.5 text-sm">
              <span>AI cost per million tokens</span>
              <Input
                type="number"
                min="0.01"
                max="10000"
                step="0.01"
                value={aiCost}
                onChange={(event) => setAiCost(event.target.value)}
              />
            </label>
            <DialogFooter>
              <Button onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Actions completed"
          value={impact.measured.runsCompleted}
          hint="measured · completed attributed runs"
          icon={Bot}
        />
        <StatTile
          label="Hours saved"
          value={Number(impact.estimated.hoursSaved.toFixed(1))}
          hint="estimated · minutes saved per run"
          icon={Clock3}
        />
        <StatTile
          label="Value created"
          value={`$${Math.round(impact.estimated.laborValueUsd).toLocaleString()}`}
          hint={`estimated · $${impact.estimated.hourlyRateUsd}/hr`}
          icon={DollarSign}
        />
        <StatTile
          label="ROI multiple"
          value={
            impact.estimated.roiMultiple === null
              ? '—'
              : `${impact.estimated.roiMultiple.toFixed(1)}×`
          }
          hint="estimated · value divided by AI cost"
          icon={TrendingUp}
        />
      </div>
    </section>
  )
}
