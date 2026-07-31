'use client'

import { useState } from 'react'
import { Bot, Clock3, DollarSign, Download, TrendingUp } from 'lucide-react'
import { toast } from 'sonner'
import { useCachedJson } from '@/lib/client/use-cached-json'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatTile } from '@/components/ui/stat-tile'

export type ImpactTiers = {
  measured: { runsCompleted: number; tokens: number; aiRunSecondsTotal: number }
  estimated: {
    hoursSaved: number
    laborValueUsd: number
    aiCostUsd: number
    roiMultiple: number | null
    hourlyRateUsd: number
    aiCostPerMTokensUsd: number
  }
  correlated: { paceDeltaPct: number | null }
}

export type OrgImpact = ImpactTiers & {
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
  const [aiCost, setAiCost] = useState(String(impact.estimated.aiCostPerMTokensUsd))
  // The write behind this dialog is admin-gated (settings:workspace) — hide
  // the trigger from members instead of letting them hit a 403.
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'

  // Re-seed the draft from the CURRENT prop values on every open (not the
  // mount-time snapshot): the page may have refetched since mount, and a
  // stale draft meant saving one field silently reverted a colleague's
  // concurrent change to the other.
  const openDialog = (next: boolean) => {
    if (next) {
      setHourlyRate(String(impact.estimated.hourlyRateUsd))
      setAiCost(String(impact.estimated.aiCostPerMTokensUsd))
    }
    setOpen(next)
  }

  const save = async () => {
    setSaving(true)
    try {
      // Send only the fields the user actually changed, so an untouched field
      // can never write a stale value back over someone else's update.
      const patch: Record<string, number> = {}
      if (Number(hourlyRate) !== impact.estimated.hourlyRateUsd) patch.laborHourlyRate = Number(hourlyRate)
      if (Number(aiCost) !== impact.estimated.aiCostPerMTokensUsd) patch.aiCostPerMTokensUsd = Number(aiCost)
      if (Object.keys(patch).length === 0) {
        setOpen(false)
        return
      }
      const response = await fetch('/api/goals/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
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
            Measured activity and honest estimates, org-wide. The third tier —
            correlated goal movement — is shown per goal on each goal&apos;s page.
          </p>
        </div>
        <Dialog open={open} onOpenChange={openDialog}>
          {isAdmin && (
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm">
                Edit assumptions
              </Button>
            </DialogTrigger>
          )}
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
          hint={`${formatDuration(impact.measured.aiRunSecondsTotal)} measured AI run time`}
          icon={Bot}
          accent="blue"
        />
        <StatTile
          label="Hours saved"
          value={Number(impact.estimated.hoursSaved.toFixed(1))}
          hint="estimated · minutes saved per run"
          icon={Clock3}
          accent="violet"
        />
        <StatTile
          label="Value created"
          value={`$${Math.round(impact.estimated.laborValueUsd).toLocaleString()}`}
          hint={`estimated · $${impact.estimated.hourlyRateUsd}/hr`}
          icon={DollarSign}
          accent="emerald"
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
          accent="amber"
        />
      </div>
    </section>
  )
}

export function ExportRoiReport() {
  const [months, setMonths] = useState('3')
  return (
    <div className="flex items-center gap-2">
      <Select value={months} onValueChange={setMonths}>
        <SelectTrigger className="h-9 w-28" aria-label="ROI report window">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="3">3 months</SelectItem>
          <SelectItem value="6">6 months</SelectItem>
          <SelectItem value="12">12 months</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        onClick={() => window.location.assign(`/api/goals/report?months=${months}`)}
      >
        <Download className="mr-2 h-4 w-4" />
        Export ROI report
      </Button>
    </div>
  )
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`
}
