'use client'

/**
 * The one filter bar every library grid runs on — templates, skills, and the
 * starter catalogue.
 *
 * It replaces two controls that did different things. The search box did not
 * search: typing set state and nothing moved, and only Enter (or "Ask AI")
 * did anything, answering in a separate suggestions panel above a grid that
 * stayed unfiltered. Department was a wrapping row of pills that narrowed the
 * Starter catalogue alone — a user's own templates and every skill ignored it.
 *
 * Now search filters as you type, Category is a dropdown built from what the
 * grid actually holds, and Department sits beside it, so the whole control
 * stays one line however far the catalogue grows. "Ask AI" survives as a
 * secondary action for describing a goal in prose; it is no longer the only
 * way to find anything.
 *
 * Department is derived where it is not stored — see @/lib/templates/library-filters.
 */

import { Search, Sparkles, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ALL_FILTER } from '@/lib/templates/library-filters'
import { PRODUCT_DEPARTMENTS } from '@/lib/templates/departments'
import { cn } from '@/lib/utils'

/** Sentence-case a department slug; CSM is an initialism, not a word. */
export function departmentLabel(dept: string): string {
  return dept === 'csm' ? 'CSM' : dept.charAt(0).toUpperCase() + dept.slice(1)
}

export function LibraryFilterBar({
  search,
  onSearchChange,
  categories,
  category,
  onCategoryChange,
  department,
  onDepartmentChange,
  onAskAi,
  askAiLoading = false,
  searchPlaceholder = 'Search templates, skills, and tools…',
}: {
  search: string
  onSearchChange: (value: string) => void
  /** The real categories present in the grids, without the "All" entry. */
  categories: string[]
  category: string
  onCategoryChange: (value: string) => void
  department: string
  onDepartmentChange: (value: string) => void
  /** Omitted where a grid has no AI matching (the flow gallery). */
  onAskAi?: () => void
  askAiLoading?: boolean
  searchPlaceholder?: string
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-4">
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          // type/name/autoComplete together stop browser autofill treating a
          // bare text input as an identity field and pre-filling the saved
          // email — which silently filters every grid to nothing.
          type="search"
          name="library-search"
          autoComplete="off"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label="Search the library"
          className={cn(
            'h-11 w-full rounded-full pl-10 [&::-webkit-search-cancel-button]:hidden',
            onAskAi ? 'pr-32' : 'pr-10',
          )}
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onSearchChange('')}
            className={cn(
              'absolute top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              onAskAi ? 'right-[7.25rem]' : 'right-3',
            )}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {onAskAi && (
          <button
            type="button"
            disabled={search.trim().length < 3 || askAiLoading}
            onClick={onAskAi}
            className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-colors hover:bg-foreground/85 disabled:pointer-events-none disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {askAiLoading ? 'Asking…' : 'Ask AI'}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <FilterSelect
          id="library-category"
          label="Category"
          value={category}
          onChange={onCategoryChange}
          allLabel="All categories"
          options={categories.map((value) => ({ value, label: value }))}
          className="w-[13rem]"
        />
        <FilterSelect
          id="library-department"
          label="Department"
          value={department}
          onChange={onDepartmentChange}
          allLabel="All departments"
          options={PRODUCT_DEPARTMENTS.map((value) => ({ value, label: departmentLabel(value) }))}
          className="w-[10rem]"
        />
      </div>
    </div>
  )
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  allLabel,
  options,
  className,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  allLabel: string
  options: { value: string; label: string }[]
  className?: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* A real labelled element, not decorative text: the trigger is a button,
          so without this the dropdown is announced with no name at all. */}
      <span id={`${id}-label`} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-labelledby={`${id}-label ${id}`} className={cn('h-10 shrink-0 rounded-full', className)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* Radix forbids an empty item value, so "everything" is a sentinel
              word — the same one the filter predicates treat as no filter. */}
          <SelectItem value={ALL_FILTER}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
