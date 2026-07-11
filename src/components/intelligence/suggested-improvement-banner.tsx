'use client'

import { Lightbulb, X } from 'lucide-react'

export type SuggestedImprovement = { id: string; title: string; content: string }

/**
 * Small dismissible "Suggested improvement" card, shared by the flow builder
 * and agent config surfaces (behavioral-intelligence Task 3 improvement
 * pass — see src/lib/intelligence/suggest-workflows.ts). Renders nothing
 * when there are no open suggestions, so it never adds empty-state noise.
 */
export function SuggestedImprovementBanner({
  suggestions,
  onDismiss,
  dismissingId,
}: {
  suggestions: SuggestedImprovement[]
  onDismiss: (id: string) => void
  dismissingId?: string | null
}) {
  if (suggestions.length === 0) return null
  return (
    <div className="space-y-2">
      {suggestions.map((suggestion) => (
        <div
          key={suggestion.id}
          className="flex items-start gap-3 rounded-lg border border-indigo-200/70 bg-indigo-50/60 p-3 text-sm dark:border-indigo-500/30 dark:bg-indigo-500/5"
        >
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-300" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-indigo-900 dark:text-indigo-200">Suggested improvement: {suggestion.title}</p>
            <p className="mt-0.5 text-indigo-800/80 dark:text-indigo-200/70">{suggestion.content}</p>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(suggestion.id)}
            disabled={dismissingId === suggestion.id}
            className="shrink-0 text-indigo-400 hover:text-indigo-700 disabled:opacity-50 dark:text-indigo-300/70 dark:hover:text-indigo-200"
            aria-label={`Dismiss suggestion: ${suggestion.title}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
