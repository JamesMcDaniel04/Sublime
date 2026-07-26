'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { GOAL_TEMPLATES } from '@/lib/goals/goal-templates'
import { GOAL_KIND_LABELS } from '@/lib/types'
import { PRODUCT_DEPARTMENTS } from '@/lib/templates/departments'

const DEPARTMENT_LABELS: Record<string, string> = {
  sales: 'Sales',
  marketing: 'Marketing',
  engineering: 'Engineering',
  finance: 'Finance',
  csm: 'Customer Success',
}

/** "Start from a template": 2 org + 2 personal starting points per served
 *  department. Selecting one prefills the wizard — target and source stay
 *  the user's. */
export function GoalTemplateGallery() {
  const [department, setDepartment] = useState<string>('all')
  const visible =
    department === 'all'
      ? GOAL_TEMPLATES
      : GOAL_TEMPLATES.filter((entry) => entry.department === department)

  return (
    <section className="space-y-3" aria-labelledby="goal-templates-heading">
      <div>
        <h2 id="goal-templates-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-4 w-4 text-indigo-500" />
          Start from a template
        </h2>
        <p className="text-xs text-muted-foreground">
          Proven targets by team — pick one and we&apos;ll prefill the goal for you.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter templates by department">
        {['all', ...PRODUCT_DEPARTMENTS].map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={department === key}
            onClick={() => setDepartment(key)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              department === key
                ? 'border-foreground/30 bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {key === 'all' ? 'All teams' : DEPARTMENT_LABELS[key]}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {visible.map((entry) => (
          <Link key={entry.key} href={`/goals/new?template=${entry.key}`} className="group">
            <Card variant="interactive" className="h-full p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium group-hover:text-foreground">{entry.name}</p>
                <Badge variant={entry.scope === 'org' ? 'secondary' : 'outline'}>
                  {entry.scope === 'org' ? 'Org' : 'Personal'}
                </Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
              <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {DEPARTMENT_LABELS[entry.department]} · {GOAL_KIND_LABELS[entry.kind]}
                {entry.recurrence ? ` · ↻ ${entry.recurrence}` : ''}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  )
}
