'use client'

import { Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { normalizeFlowIcon } from '@/lib/flows/organization'

/** Suggested glyphs for a flow card — pipeline-flavoured, one tap to pick. */
const SUGGESTED_ICONS = ['📊', '📈', '✉️', '🔔', '📝', '🗓️', '🔍', '⚡', '🤖', '💼', '🚀', '✅']

/**
 * Icon picker for a flow card: a "default" tile carrying the generic Workflow
 * glyph, a row of suggestions, and a free field for any other emoji. `''`
 * means the default glyph.
 *
 * The free field runs the same `normalizeFlowIcon` the API applies, so what
 * you see here is exactly what gets stored — a pasted sentence clears back to
 * the default rather than being silently truncated to a meaningless fragment
 * after save.
 */
export function FlowIconInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const tile = (selected: boolean) =>
    cn(
      'flex h-9 w-9 items-center justify-center rounded-lg border text-base transition-colors',
      selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
    )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onChange('')}
          className={tile(value === '')}
          title="Default icon"
          aria-label="Use the default icon"
          aria-pressed={value === ''}
        >
          <Workflow className="h-[18px] w-[18px] text-muted-foreground" aria-hidden />
        </button>
        {SUGGESTED_ICONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onChange(emoji)}
            className={tile(value === emoji)}
            aria-label={`Use ${emoji} as the icon`}
            aria-pressed={value === emoji}
          >
            <span aria-hidden>{emoji}</span>
          </button>
        ))}
      </div>
      <input
        value={value}
        onChange={(event) => onChange(normalizeFlowIcon(event.target.value))}
        className="w-44 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        placeholder="Or paste any emoji"
        aria-label="Custom icon emoji"
      />
    </div>
  )
}

/**
 * A flow's icon as rendered on a card or row — the emoji when set, the generic
 * glyph when not. Kept beside the picker so the two can never disagree about
 * what `''` means.
 */
export function FlowIcon({ icon, className }: { icon?: string | null; className?: string }) {
  const glyph = normalizeFlowIcon(icon ?? '')
  if (!glyph) return <Workflow className={cn('h-4 w-4 text-muted-foreground', className)} aria-hidden />
  return <span className={cn('text-base leading-none', className)} aria-hidden>{glyph}</span>
}
