'use client'

/**
 * The shape half of a KPI composition. A funnel needs a stage count and a
 * weighted sum needs named drivers — without them the shape yields no slots
 * and the user has picked an option that renders nothing.
 */
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  MAX_FUNNEL_STAGES,
  MIN_FUNNEL_STAGES,
  driverSlot,
  type Driver,
} from './kpi-shape'
import type { KpiShape } from '@/lib/goals/composition/rollup-kpi'

export const KPI_SHAPE_OPTIONS: Array<{ value: KpiShape | 'none'; label: string }> = [
  { value: 'none', label: 'Track it as one number' },
  { value: 'ratio', label: 'A ratio — numerator over denominator' },
  { value: 'funnel', label: 'A funnel — stage to stage' },
  { value: 'weighted_sum', label: 'A weighted sum of drivers' },
]

export function KpiShapeFields({
  shape,
  stages,
  drivers,
  onStagesChange,
  onDriversChange,
}: {
  shape: KpiShape | ''
  stages: number
  drivers: Driver[]
  onStagesChange: (next: number) => void
  onDriversChange: (next: Driver[]) => void
}) {
  if (shape === 'funnel') {
    const options = Array.from(
      { length: MAX_FUNNEL_STAGES - MIN_FUNNEL_STAGES + 1 },
      (_, index) => MIN_FUNNEL_STAGES + index,
    )
    return (
      <label className="space-y-1.5 text-sm">
        <span className="font-medium">How many stages?</span>
        <Select
          value={String(stages)}
          onValueChange={(value) => onStagesChange(Number(value))}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {options.map((count) => (
              <SelectItem key={count} value={String(count)}>
                {count} stages
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          The last stage is the headline; the goal derives the conversion
          between each pair.
        </p>
      </label>
    )
  }

  if (shape !== 'weighted_sum') return null

  const setDriver = (index: number, patch: Partial<Driver>) =>
    onDriversChange(
      drivers.map((driver, position) =>
        position === index ? { ...driver, ...patch } : driver,
      ),
    )
  const slugs = drivers.map((driver) => driverSlot(driver.name))

  return (
    <div className="space-y-2 text-sm">
      <div>
        <span className="font-medium">Which drivers make up this number?</span>
        <p className="text-xs text-muted-foreground">
          Each driver is weighted, then summed. Leave a weight blank to count it
          once.
        </p>
      </div>
      {drivers.map((driver, index) => {
        // A name that slugs to nothing, or collides with an earlier driver,
        // cannot be sent — the create route rejects duplicate slots outright.
        const slug = slugs[index]
        const duplicate = Boolean(slug) && slugs.indexOf(slug) !== index
        return (
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-2">
              <Input
                value={driver.name}
                onChange={(event) => setDriver(index, { name: event.target.value })}
                placeholder="Driver name (AWS)"
                aria-label={`Driver ${index + 1} name`}
                className="flex-1"
              />
              <Input
                value={driver.weight}
                onChange={(event) => setDriver(index, { weight: event.target.value })}
                placeholder="1"
                inputMode="decimal"
                aria-label={`Driver ${index + 1} weight`}
                className="w-20"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove driver ${index + 1}`}
                onClick={() =>
                  onDriversChange(drivers.filter((_, position) => position !== index))
                }
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {driver.name.trim() !== '' && !slug && (
              <p className="text-xs text-destructive">
                Give this driver a name with letters or numbers.
              </p>
            )}
            {duplicate && (
              <p className="text-xs text-destructive">
                Another driver already uses this name.
              </p>
            )}
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onDriversChange([...drivers, { name: '', weight: '' }])}
      >
        <Plus className="mr-1.5 h-4 w-4" /> Add driver
      </Button>
    </div>
  )
}
