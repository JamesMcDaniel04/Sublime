'use client'

/** Placeholder — Task 8 adds the pin control and empty states. */
export function OutputPane({ lastOutput }: { lastOutput: unknown; pinned: boolean }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <p className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Output</p>
      <pre className="p-4 font-mono text-xs">{lastOutput === undefined ? '' : JSON.stringify(lastOutput, null, 2)}</pre>
    </div>
  )
}
