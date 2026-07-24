'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { controlClass } from './nodes/field-primitives'

export type SearchableOption = { value: string; label: string; hint?: string }

/**
 * A typeahead replacement for a bare `<select>`.
 *
 * The connection and action pickers draw from the live tool catalog, which for
 * a real MCP server runs to hundreds of actions — a dropdown you can only
 * scroll is unusable at that size. Search covers the hint as well as the label,
 * because people look for what an action DOES ("post a message") far more often
 * than its snake_case id.
 */
export function SearchableSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Choose…',
  invalid = false,
  emptyLabel = 'Nothing to choose from yet.',
}: Readonly<{
  value: string
  options: SearchableOption[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  invalid?: boolean
  emptyLabel?: string
}>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = options.find((option) => option.value === value)

  // A stale query would hide options the user expects on reopen.
  const close = () => {
    setOpen(false)
    setQuery('')
  }

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const normalized = query.trim().toLowerCase()
  const matches = normalized
    ? options.filter((option) => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(normalized))
    : options

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        // combobox, not the implicit button role: this control has a popup and
        // a value, and aria-invalid is only meaningful (and only valid) here.
        role="combobox"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          controlClass,
          'flex w-full items-center justify-between gap-2 text-left',
          invalid && 'border-red-400 focus:border-red-500',
        )}
      >
        <span className={cn('min-w-0 truncate', !selected && 'text-muted-foreground')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              role="textbox"
              aria-label={`Search ${ariaLabel}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  close()
                }
              }}
              placeholder="Search…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div id={listId} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto">
            {options.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-muted-foreground">{emptyLabel}</p>
            ) : matches.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-muted-foreground">No matches for “{query.trim()}”.</p>
            ) : (
              matches.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  onClick={() => {
                    onChange(option.value)
                    close()
                  }}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/60"
                >
                  <Check
                    className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', option.value === value ? 'text-indigo-600' : 'invisible')}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{option.label}</span>
                    {option.hint && <span className="block truncate text-[11px] text-muted-foreground">{option.hint}</span>}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
