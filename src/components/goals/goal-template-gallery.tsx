'use client'

import { useEffect, useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Pagination, paginate } from '@/components/ui/pagination'
import { GoalTemplateCard } from '@/components/goals/goal-template-card'
import { GoalTemplateDetail } from '@/components/goals/goal-template-detail'
import { GOAL_TEMPLATES, type GoalTemplate } from '@/lib/goals/goal-templates'
import { connectedSourceSet, type MetricSourceOption } from '@/lib/metrics/source-options'
import { PRODUCT_DEPARTMENTS } from '@/lib/templates/departments'

const PAGE_SIZE = 9

const DEPARTMENT_LABELS: Record<string, string> = {
  sales: 'Sales',
  marketing: 'Marketing',
  engineering: 'Engineering',
  finance: 'Finance',
  csm: 'Customer Success',
}

/**
 * "Start from a template": 45 starting points, nine per served department,
 * nine to a page. Clicking a card opens its detail dialog — tools, what gets
 * tracked, and a preview of the dashboard it produces. Nothing is created
 * until the wizard, where the target and source stay the user's.
 *
 * Page state is deliberately component-local rather than in the URL: the
 * gallery sits mid-page on /goals and must not push history entries.
 */
export function GoalTemplateGallery() {
  const [department, setDepartment] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<GoalTemplate | null>(null)
  const [sources, setSources] = useState<MetricSourceOption[]>([])
  const [sourcesFailed, setSourcesFailed] = useState(false)

  // Best-effort: connection state decorates the cards, it never gates them.
  useEffect(() => {
    let cancelled = false
    fetch('/api/goals/metrics/sources', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'sources unavailable')
        if (!cancelled) setSources(body.sources ?? [])
      })
      .catch(() => {
        if (!cancelled) setSourcesFailed(true)
      })
    return () => { cancelled = true }
  }, [])

  const connected = useMemo(
    () => (sourcesFailed ? new Set<string>() : connectedSourceSet(sources)),
    [sources, sourcesFailed],
  )

  const visible = useMemo(
    () =>
      department === 'all'
        ? GOAL_TEMPLATES
        : GOAL_TEMPLATES.filter((entry) => entry.department === department),
    [department],
  )
  const { pageItems, pageCount, page: currentPage } = paginate(visible, page, PAGE_SIZE)

  return (
    <section className="space-y-3" aria-labelledby="goal-templates-heading">
      <div>
        <h2 id="goal-templates-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-4 w-4 text-indigo-500" />
          Start from a template
        </h2>
        <p className="text-xs text-muted-foreground">
          Proven targets by team — open one to see what it tracks and the dashboard you&apos;ll get.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter templates by department">
        {['all', ...PRODUCT_DEPARTMENTS].map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={department === key}
            onClick={() => { setDepartment(key); setPage(1) }}
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pageItems.map((entry) => (
          <GoalTemplateCard
            key={entry.key}
            template={entry}
            connectedSources={connected}
            onOpen={setSelected}
          />
        ))}
      </div>

      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />

      <GoalTemplateDetail
        template={selected}
        sources={sources}
        sourcesFailed={sourcesFailed}
        onClose={() => setSelected(null)}
      />
    </section>
  )
}
