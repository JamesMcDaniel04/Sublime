'use client'

import { useMemo, useState } from 'react'
import { AlignVerticalJustifyCenter, ChevronDown, Grid3X3, Maximize2, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Floating zoom / fit / search rail anchored to the canvas scroll container. */
export function CanvasRail({
  zoom,
  onZoom,
  onFit,
  onAutoFormat,
  onCollapseAll,
  snapToGrid,
  onToggleSnap,
  nodes,
  onJump,
}: {
  zoom: number
  onZoom: (zoom: number) => void
  onFit: () => void
  onAutoFormat: () => void
  onCollapseAll: () => void
  snapToGrid: boolean
  onToggleSnap: () => void
  nodes: { id: string; title: string }[]
  onJump: (id: string) => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return nodes
    return nodes.filter((node) => node.title.toLowerCase().includes(q))
  }, [nodes, query])

  const stop = (event: React.MouseEvent) => event.stopPropagation()

  return (
    <div
      className="absolute bottom-6 left-4 z-10 flex flex-col items-stretch overflow-hidden rounded-xl border border-border bg-card shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
      onClick={stop}
    >
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onZoom(zoom + 0.1)
        }}
        aria-label="Zoom in"
        title="Zoom in"
        className="flex h-9 w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onAutoFormat()
        }}
        aria-label="Auto format"
        title="Auto format"
        className="flex h-9 w-9 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <AlignVerticalJustifyCenter className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onCollapseAll()
        }}
        aria-label="Collapse all steps"
        title="Collapse all steps"
        className="flex h-9 w-9 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onToggleSnap()
        }}
        aria-label={snapToGrid ? 'Disable snap to grid' : 'Enable snap to grid'}
        title={snapToGrid ? 'Snap to grid: on' : 'Snap to grid: off'}
        className={cn(
          'flex h-9 w-9 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          snapToGrid && 'bg-blue-50 text-blue-700',
        )}
      >
        <Grid3X3 className="h-4 w-4" />
      </button>
      <div className="w-full border-t border-border py-1 text-center text-[10px] font-semibold text-muted-foreground">
        {Math.round(zoom * 100)}%
      </div>
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onZoom(zoom - 0.1)
        }}
        aria-label="Zoom out"
        title="Zoom out"
        className="flex h-9 w-9 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onFit()
        }}
        aria-label="Fit view"
        title="Fit view"
        className="flex h-9 w-9 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Maximize2 className="h-4 w-4" />
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={(event) => {
            stop(event)
            setSearchOpen((open) => !open)
          }}
          aria-label="Search steps"
          title="Search steps"
          className={cn(
            'flex h-9 w-9 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            searchOpen && 'bg-muted text-foreground',
          )}
        >
          <Search className="h-4 w-4" />
        </button>
        {searchOpen && (
          <div
            className="absolute bottom-0 left-full ml-2 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
            onClick={stop}
          >
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search steps..."
              className="w-full border-b border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="max-h-56 overflow-y-auto py-1">
              {results.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No matching steps.</p>}
              {results.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={(event) => {
                    stop(event)
                    onJump(node.id)
                    setSearchOpen(false)
                    setQuery('')
                  }}
                  className="block w-full truncate px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
                >
                  {node.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
