'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A dependency-free month calendar for picking a single date. Value and
 * onChange speak 'YYYY-MM-DD' local-date strings (no time, no timezone — the
 * caller pairs the date with a separate time + timezone). Days before `min`
 * (also 'YYYY-MM-DD') are disabled.
 */

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

function parseKey(key: string | undefined): { year: number; month: number; day: number } | null {
  if (!key) return null
  const [y, m, d] = key.split('-').map(Number)
  if (!y || !m || !d) return null
  return { year: y, month: m - 1, day: d }
}

export function MiniCalendar({
  value,
  onChange,
  min,
}: {
  value?: string
  onChange: (date: string) => void
  /** Earliest selectable date, 'YYYY-MM-DD'. Days before it are disabled. */
  min?: string
}) {
  const selected = parseKey(value)
  const now = new Date()
  const initial = selected ?? { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() }
  const [view, setView] = React.useState({ year: initial.year, month: initial.month })

  const firstWeekday = new Date(view.year, view.month, 1).getDay()
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate()

  const cells: Array<number | null> = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  const step = (delta: number) => {
    setView((v) => {
      const m = v.month + delta
      if (m < 0) return { year: v.year - 1, month: 11 }
      if (m > 11) return { year: v.year + 1, month: 0 }
      return { year: v.year, month: m }
    })
  }

  return (
    <div className="w-full rounded-lg border bg-background p-3 shadow-1">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => step(-1)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold">{MONTHS[view.month]} {view.year}</span>
        <button
          type="button"
          onClick={() => step(1)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground"
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((d) => (
          <div key={d} className="flex h-7 items-center justify-center font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`pad-${i}`} className="h-8" />
          const key = toKey(view.year, view.month, day)
          const isSelected = value === key
          const isDisabled = Boolean(min) && key < min!
          return (
            <button
              key={key}
              type="button"
              disabled={isDisabled}
              onClick={() => onChange(key)}
              className={cn(
                'flex h-8 items-center justify-center rounded-md text-sm transition-colors duration-fast',
                isSelected
                  ? 'bg-primary font-semibold text-primary-foreground'
                  : isDisabled
                    ? 'cursor-not-allowed text-muted-foreground/40'
                    : 'text-foreground hover:bg-accent',
              )}
            >
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}
