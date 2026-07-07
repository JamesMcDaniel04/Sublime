'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Simple client-side pager for card grids. Renders nothing when everything
 * fits on one page. Page is 1-indexed.
 */
export function Pagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}) {
  if (pageCount <= 1) return null
  return (
    <div className="flex items-center justify-center gap-3 pt-4">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        <ChevronLeft className="h-4 w-4" /> Previous
      </Button>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        Page {page} of {pageCount}
      </span>
      <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>
        Next <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

/** Clamp + slice one page out of a list. */
export function paginate<T>(items: T[], page: number, pageSize: number): { pageItems: T[]; pageCount: number; page: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const clamped = Math.min(Math.max(1, page), pageCount)
  return { pageItems: items.slice((clamped - 1) * pageSize, clamped * pageSize), pageCount, page: clamped }
}
