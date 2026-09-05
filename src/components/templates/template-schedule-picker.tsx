'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cadenceOf, cronToTime, daysFromCron, dowCron, type Cadence, type ScheduleDraft } from '@/lib/agents/schedule-form'
import { cn } from '@/lib/utils'

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

/** The cadences a template can be customized to before deploy. */
type PickerCadence = 'manual' | Exclude<Cadence, 'once'>

const CADENCE_LABELS: Record<PickerCadence, string> = {
  manual: 'Run manually',
  hourly: 'Every hour',
  daily: 'Every day',
  daysofweek: 'Specific weekdays',
  weekly: 'Every week',
  custom: 'Custom cron',
}

function pickerCadence(schedule: ScheduleDraft): PickerCadence {
  if (schedule.type === 'manual' || !schedule.isActive) return 'manual'
  const cadence = cadenceOf(schedule)
  return cadence === 'once' ? 'custom' : cadence
}

/**
 * Compact schedule editor for the template detail page. Same cadence
 * vocabulary as the agent config form (schedule-form.ts), minus one-time
 * runs — a template describes recurring work, and a one-off can be set in
 * Agent settings after deploy.
 */
export function TemplateSchedulePicker({
  value,
  onChange,
  timezone,
}: {
  value: ScheduleDraft
  onChange: (next: ScheduleDraft) => void
  /** The viewer's zone, offered next to UTC and the template's own zone. */
  timezone: string
}) {
  const cadence = pickerCadence(value)
  const time = value.time || (value.cron ? cronToTime(value.cron) : '09:00')
  const days = daysFromCron(value.cron)
  const zones = Array.from(new Set(['UTC', value.timezone, timezone].filter(Boolean)))

  const setCadence = (next: PickerCadence) => {
    const base = { timezone: value.timezone || 'UTC', isActive: true }
    switch (next) {
      case 'manual': onChange({ type: 'manual', time: '', cron: '', timezone: base.timezone, isActive: false }); break
      case 'hourly': onChange({ ...base, type: 'hourly', time: '', cron: '' }); break
      case 'daily': onChange({ ...base, type: 'daily', time, cron: '' }); break
      case 'weekly': onChange({ ...base, type: 'weekly', time, cron: '' }); break
      case 'daysofweek': onChange({ ...base, type: 'cron', time: '', cron: dowCron(time, days) }); break
      case 'custom': onChange({ ...base, type: 'cron', time: '', cron: value.cron || '0 9 * * 1-5' }); break
    }
  }

  const setTime = (nextTime: string) => {
    if (cadence === 'daysofweek') onChange({ ...value, cron: dowCron(nextTime, days) })
    else onChange({ ...value, time: nextTime })
  }

  const toggleDay = (day: number) => {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day]
    onChange({ ...value, cron: dowCron(time, next) })
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="template-cadence">Runs</Label>
          <Select value={cadence} onValueChange={(next) => setCadence(next as PickerCadence)}>
            <SelectTrigger id="template-cadence" className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(CADENCE_LABELS) as PickerCadence[]).map((key) => (
                <SelectItem key={key} value={key}>{CADENCE_LABELS[key]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {cadence !== 'manual' && cadence !== 'hourly' && (
          <div>
            <Label htmlFor="template-timezone">Time zone</Label>
            <Select value={value.timezone || 'UTC'} onValueChange={(next) => onChange({ ...value, timezone: next })}>
              <SelectTrigger id="template-timezone" className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {zones.map((zone) => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {(cadence === 'daily' || cadence === 'weekly' || cadence === 'daysofweek') && (
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="template-time">At</Label>
            <Input id="template-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} className="h-9 w-32" />
          </div>
          {cadence === 'daysofweek' && (
            <div>
              <p id="template-days-label" className="text-sm font-medium leading-none">On</p>
              <div className="mt-2 flex gap-1" role="group" aria-labelledby="template-days-label">
                {DAY_LABELS.map((label, day) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={days.includes(day)}
                    onClick={() => toggleDay(day)}
                    className={cn(
                      'h-9 w-9 rounded-md border text-xs font-medium transition-colors',
                      days.includes(day) ? 'border-indigo-600 bg-indigo-600 text-white' : 'bg-background text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {cadence === 'custom' && (
        <div>
          <Label htmlFor="template-cron">Cron expression</Label>
          <Input
            id="template-cron"
            value={value.cron ?? ''}
            // A one-time schedule shows here as "custom" (there is no one-time
            // cadence in this picker), so an edit must make it a real cron
            // schedule rather than a one-time run carrying a cron it ignores.
            onChange={(event) => onChange({ ...value, type: 'cron', runAt: undefined, time: '', cron: event.target.value })}
            placeholder="0 9 * * 1-5"
            className="h-9 font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">Five fields: minute, hour, day of month, month, day of week.</p>
        </div>
      )}
    </div>
  )
}
