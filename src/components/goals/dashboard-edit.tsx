'use client'

import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, LayoutGrid, Plus, X } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  WIDGET_LABELS,
  WIDGET_TYPES,
  defaultLayoutForGoal,
  parseDashboardLayout,
  type DashboardLayout,
  type DashboardWidget,
  type WidgetType,
} from '@/lib/goals/dashboard'
import type { GoalDetail } from '@/lib/types'

export function DashboardEditDialog({
  goal,
  onSaved,
}: {
  goal: GoalDetail
  onSaved: () => void | Promise<void>
}) {
  const initial = () =>
    (parseDashboardLayout(goal.dashboardLayout) ?? defaultLayoutForGoal())
      .widgets
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [widgets, setWidgets] = useState<DashboardWidget[]>(initial)
  const [addType, setAddType] = useState<WidgetType | ''>('')

  useEffect(() => {
    if (!open) setWidgets(initial())
    // goal.dashboardLayout is the persistence source; initial is intentionally
    // recreated when a save/reload closes the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.dashboardLayout, open])

  const move = (index: number, delta: -1 | 1) => {
    const next = [...widgets]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setWidgets(next)
  }
  const addable = WIDGET_TYPES.filter((type) => {
    if (type === 'ratio' || type === 'comparison') {
      return goal.metrics.length >= 2
    }
    return type !== 'narrative'
  })
  const add = () => {
    if (!addType) return
    const config: Record<string, unknown> =
      addType === 'ratio'
        ? {
            numeratorId: goal.metrics[0].id,
            denominatorId: goal.metrics[1].id,
            format: 'percent',
          }
        : addType === 'comparison'
          ? { metricIds: goal.metrics.slice(0, 2).map((metric) => metric.id) }
          : {}
    setWidgets([
      ...widgets,
      { id: `w-${Date.now()}`, type: addType, config },
    ])
    setAddType('')
  }
  const save = async () => {
    setSaving(true)
    try {
      const layout: DashboardLayout = { version: 1, widgets }
      const response = await fetch(`/api/goals/${goal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dashboardLayout: layout }),
      })
      const body = await response.json()
      if (!response.ok) {
        throw new Error(body.error || 'Could not save the dashboard.')
      }
      await onSaved()
      setOpen(false)
      toast.success('Dashboard updated.')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not save the dashboard.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <LayoutGrid className="mr-1.5 h-4 w-4" /> Dashboard
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit dashboard</DialogTitle>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {widgets.map((widget, index) => (
            <div
              key={widget.id}
              className="flex items-center justify-between gap-2 rounded-xl border p-2.5"
            >
              <span className="text-sm font-medium">
                {WIDGET_LABELS[widget.type]}
              </span>
              <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Move down"
                  disabled={index === widgets.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Remove"
                  onClick={() =>
                    setWidgets(
                      widgets.filter((entry) => entry.id !== widget.id),
                    )
                  }
                >
                  <X className="h-4 w-4" />
                </Button>
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={addType}
            onValueChange={(value) => setAddType(value as WidgetType)}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Add a widget" />
            </SelectTrigger>
            <SelectContent>
              {addable.map((type) => (
                <SelectItem key={type} value={type}>
                  {WIDGET_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={add} disabled={!addType}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setWidgets(defaultLayoutForGoal().widgets)}
          >
            Reset to default
          </Button>
          <Button
            onClick={save}
            disabled={saving || widgets.length === 0}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
