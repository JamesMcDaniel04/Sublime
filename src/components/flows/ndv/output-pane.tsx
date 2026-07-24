'use client'

import { Pin } from 'lucide-react'

/**
 * The NDV's right pane: what this node produced on its last run (or the
 * pinned fixture standing in for it), plus the pin control. Pinned data is
 * visibly badged — it is stale by construction, and debugging against a
 * fixture without knowing is the failure mode to avoid.
 */
export function OutputPane({
  lastOutput,
  pinned,
  onPin,
  onUnpin,
  error,
}: {
  lastOutput: unknown
  pinned: boolean
  onPin?: () => void
  onUnpin?: () => void
  /** The last node test's failure — shown above the (stale) output. */
  error?: string
}) {
  const hasOutput = lastOutput !== undefined && lastOutput !== null
  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Output</p>
        {pinned && (
          <span className="flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            <Pin className="h-3 w-3" /> Pinned
          </span>
        )}
      </div>
      {error && (
        <p className="break-words border-b border-red-200 bg-red-50 px-4 py-2.5 font-mono text-[11px] leading-relaxed text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      )}
      {hasOutput ? (
        <>
          <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
            {typeof lastOutput === 'string' ? lastOutput : JSON.stringify(lastOutput, null, 2)}
          </pre>
          <div className="border-t border-border p-3">
            {pinned ? (
              <button type="button" onClick={onUnpin} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
                Unpin
              </button>
            ) : (
              <button type="button" onClick={onPin} className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                <Pin className="h-3.5 w-3.5" /> Pin this output
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">This step hasn&apos;t produced output yet. Run the flow — or test this step — to see what it returns.</p>
      )}
    </div>
  )
}
