'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
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

/** A template is "ready" when some source it reads is already connected.
 *  `manual` never counts — every template can fall back to manual entry, so
 *  counting it would mark all 45 ready and the signal would say nothing. */
const isReady = (template: GoalTemplate, connected: Set<string>) =>
  template.sources.some((source) => source !== 'manual' && connected.has(source))

/** Stable partition: ready templates first, never dropping any. Mirrors
 *  sortByReadiness on the agent catalogue — sort and annotate, never hide. */
const byReadiness = (templates: readonly GoalTemplate[], connected: Set<string>) =>
  [...templates].sort(
    (a, b) => Number(isReady(b, connected)) - Number(isReady(a, connected)),
  )

/**
 * "Start from a template": 45 starting points, nine per served department,
 * nine to a page. Clicking a card opens its detail dialog — tools, what gets
 * tracked, and a preview of the dashboard it produces. Nothing is created
 * until the wizard, where the target and source stay the user's.
 *
 * Presentation deliberately matches the agent/flow starter catalogue — same
 * card shell, same gap-6 stagger grid, same horizon department pills — so the
 * two catalogues read as one system rather than two.
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
  const loadSources = useCallback(async () => {
    try {
      const response = await fetch('/api/goals/metrics/sources', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'sources unavailable')
      setSources(body.sources ?? [])
      setSourcesFailed(false)
    } catch {
      setSourcesFailed(true)
    }
  }, [])

  useEffect(() => { void loadSources() }, [loadSources])

  const connected = useMemo(
    () => (sourcesFailed ? new Set<string>() : connectedSourceSet(sources)),
    [sources, sourcesFailed],
  )

  const visible = useMemo(() => {
    const inDepartment =
      department === 'all'
        ? GOAL_TEMPLATES
        : GOAL_TEMPLATES.filter((entry) => entry.department === department)
    return byReadiness(inDepartment, connected)
  }, [department, connected])
  const { pageItems, pageCount, page: currentPage } = paginate(visible, page, PAGE_SIZE)

  return (
    <section className="space-y-4" aria-labelledby="goal-templates-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="goal-templates-heading" className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-4 w-4 text-chart-violet" />
            Start from a template
          </h2>
          <p className="text-sm text-muted-foreground">
            Proven targets by team, sorted by what you can measure right now — open one
            to see what it tracks and the dashboard you&apos;ll get.
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
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                // Horizon explicitly, not `indigo-*` — the config remaps
                // indigo to neutral tokens, so the active pill rendered gray.
                department === key
                  ? 'border-horizon-300 bg-horizon-50 text-horizon-700 dark:border-horizon-500/40 dark:bg-horizon-500/15 dark:text-horizon-200'
                  : 'border-border/60 bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {key === 'all' ? 'All teams' : DEPARTMENT_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {pageItems.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No goal templates for this team yet"
          description="Try another team, or browse them all with All teams."
        />
      ) : (
        <div className="stagger-children grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {pageItems.map((entry) => (
            <GoalTemplateCard
              key={entry.key}
              template={entry}
              connectedSources={connected}
              onOpen={setSelected}
            />
          ))}
        </div>
      )}

      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />

      <GoalTemplateDetail
        template={selected}
        sources={sources}
        sourcesFailed={sourcesFailed}
        onClose={() => setSelected(null)}
        // Connecting from inside the detail dialog changes what is connected,
        // so re-read the sources and let the readiness badges catch up without
        // the user leaving the gallery.
        onSourcesChanged={() => void loadSources()}
      />
    </section>
  )
}
