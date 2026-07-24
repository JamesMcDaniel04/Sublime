'use client'

import { CornerDownRight } from 'lucide-react'
import { previewToken } from '@/lib/flows/preview-context'
import type { FlowContext } from '@/features/flows/context'

/**
 * The "→ resolved value" line under a token field: what this field will send,
 * using sample data from the last run / pinned outputs / test input.
 *
 * Renders nothing when there is nothing worth saying (no tokens, empty field,
 * or no sample data at all) — this line only earns its space by being signal
 * rather than decoration.
 */
export function FieldPreview({ value, ctx }: Readonly<{ value: string; ctx?: FlowContext }>) {
  if (!ctx) return null
  const preview = previewToken(value, ctx)
  if (preview.kind === 'empty' || preview.kind === 'literal') return null
  if (preview.kind === 'unresolved') {
    return (
      <p className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-amber-700 dark:text-amber-500">
        <CornerDownRight className="mt-px h-3 w-3 shrink-0" />
        <span>
          No sample data for <span className="font-mono">{preview.missing.join(', ')}</span> — run the step, or pin an
          earlier one, to preview it.
        </span>
      </p>
    )
  }
  return (
    <p className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-muted-foreground">
      <CornerDownRight className="mt-px h-3 w-3 shrink-0" />
      <span className="break-all font-mono" title="Resolved from the last run's data — a sample, not a live call.">
        {preview.text}
      </span>
    </p>
  )
}
