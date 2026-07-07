'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { Workflow, Plus, Copy } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Pagination, paginate } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Cards per page on the Flows grid. */
const PAGE_SIZE = 9

type FlowItem = {
  id: string
  name: string
  description: string
  status: string
  stepCount: number
  updatedAt: string
  graph?: unknown
  trigger?: unknown
}

const STATUS_STYLE: Record<string, string> = {
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  draft: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  disabled: 'border-border bg-muted text-muted-foreground',
}

export default function FlowsPage() {
  const router = useRouter()
  const [flows, setFlows] = useState<FlowItem[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/flows', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setFlows(data.success ? data.flows : [])
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const createFlow = async () => {
    setCreating(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Untitled flow' }),
      })
      const data = await response.json()
      if (response.ok && data.flow) router.push(`/flows/${data.flow.id}`)
      else toast.error(data.error || 'Could not create the flow.')
    } finally {
      setCreating(false)
    }
  }

  const cloneFlow = async (flow: FlowItem) => {
    const response = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${flow.name} copy`, description: flow.description, graph: flow.graph, trigger: flow.trigger }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data.flow) setFlows((prev) => [data.flow, ...prev])
    else toast.error(data.error || 'Could not duplicate the flow.')
  }

  const { pageItems, pageCount, page: current } = paginate(flows, page, PAGE_SIZE)

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader eyebrow="Pipelines" title="Flows" description="Wire your agents into deterministic multi-step pipelines." />
        <Button onClick={createFlow} loading={creating}>
          <Plus className="mr-1.5 h-4 w-4" /> New flow
        </Button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No flows yet"
          description="Build your first agent pipeline — chain agents, branch on results, and fan out over accounts."
          action={
            <Button onClick={createFlow} loading={creating}>
              <Plus className="mr-1.5 h-4 w-4" /> New flow
            </Button>
          }
        />
      ) : (
        <>
          <div className="stagger-children grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {pageItems.map((flow) => (
              <Link key={flow.id} href={`/flows/${flow.id}`} className="block">
                <Card className="group relative h-full overflow-hidden border-border/60 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:ring-1 hover:ring-indigo-300/70 dark:hover:ring-indigo-500/40">
                  <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo-500 to-blue-400 opacity-80 transition-opacity group-hover:opacity-100" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      cloneFlow(flow)
                    }}
                    aria-label="Duplicate flow"
                    className="absolute right-2 top-2 z-10 hidden rounded-md border border-border bg-card p-1.5 text-muted-foreground shadow-1 hover:text-indigo-600 group-hover:block"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <CardHeader className="space-y-2.5 pt-5">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className={cn('text-[11px] font-medium capitalize', STATUS_STYLE[flow.status] || STATUS_STYLE.draft)}>
                        {flow.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{flow.stepCount} step{flow.stepCount === 1 ? '' : 's'}</span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 transition-transform group-hover:scale-105 dark:bg-indigo-500/15 dark:text-indigo-300">
                        <Workflow className="h-[18px] w-[18px]" />
                      </span>
                      <CardTitle className="min-w-0 text-base leading-snug">{flow.name}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{flow.description || 'No description yet.'}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          <Pagination page={current} pageCount={pageCount} onPageChange={setPage} />
        </>
      )}
    </div>
  )
}
