'use client'

/**
 * Share control for a flow or agent — the UI for the org sharing roles enforced
 * in lib/server/visibility.
 *
 * The platform's thesis is that orchestration is collaborative rather than "one
 * person builds it then hands it over", so this is deliberately a first-class
 * header control, not buried in settings.
 *
 * Only the OWNER may change sharing (the API enforces this too — an org_editor
 * must not be able to re-share someone else's work), so for everyone else this
 * renders as a read-only badge explaining the current state.
 */
import { Check, ChevronDown, Globe, Lock, Pencil } from 'lucide-react'
import { useState } from 'react'
import { VISIBILITY, type Visibility } from '@/lib/server/visibility'
import { cn } from '@/lib/utils'

type Option = { value: Visibility; label: string; hint: string; icon: typeof Lock }

const OPTIONS: Option[] = [
  { value: VISIBILITY.private, label: 'Private', hint: 'Only you (and anyone you invite to a Jam)', icon: Lock },
  { value: VISIBILITY.orgViewer, label: 'Org can view', hint: 'Anyone in your workspace can open and run it', icon: Globe },
  { value: VISIBILITY.orgEditor, label: 'Org can edit', hint: 'Anyone in your workspace can build on it with you', icon: Pencil },
]

/**
 * Anything that isn't an explicit org role is Private — including the legacy
 * `'shared'` value, which the access rules never honoured. Showing it as shared
 * would tell the user their work is exposed when it isn't.
 */
export function normalizeShareValue(value: string | undefined): Visibility {
  return value === VISIBILITY.orgViewer || value === VISIBILITY.orgEditor ? value : VISIBILITY.private
}

export function ShareControl({
  value,
  canShare,
  onChange,
  className,
}: Readonly<{
  value: string | undefined
  /** Owner-only: the API rejects a non-owner changing this, so don't offer it. */
  canShare: boolean
  onChange: (next: Visibility) => void
  className?: string
}>) {
  const [open, setOpen] = useState(false)
  const current = normalizeShareValue(value)
  const active = OPTIONS.find((option) => option.value === current) ?? OPTIONS[0]
  const Icon = active.icon

  if (!canShare) {
    return (
      <span
        className={cn('flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-500', className)}
        title={`${active.hint} — only the owner can change sharing`}
      >
        <Icon className="h-3.5 w-3.5" /> {active.label}
      </span>
    )
  }

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:border-blue-400 hover:text-blue-700"
        title={active.hint}
      >
        <Icon className="h-3.5 w-3.5" /> {active.label}
        <ChevronDown className="h-3 w-3 text-slate-400" />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-72 overflow-hidden rounded-xl border border-slate-200 bg-card p-1 shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
            {OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setOpen(false)
                  if (option.value !== current) onChange(option.value)
                }}
                className="flex w-full items-start gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-slate-50"
              >
                <option.icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-950">{option.label}</span>
                  <span className="block text-xs text-slate-500">{option.hint}</span>
                </span>
                {option.value === current && <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
