'use client'

import { JsonTokenView } from './json-token-view'

/**
 * The NDV's left pane: exactly what this node will receive, as raw JSON.
 * Clicking any value inserts its token at the caret of the last-focused param
 * field; dragging a value drops the braced token into any token editor.
 *
 * There is deliberately no summarised "fields" view — one place to read
 * upstream data, and it shows the real payload.
 */
export function InputPane({
  rawInput,
  onInsertToken,
}: {
  rawInput?: unknown
  onInsertToken: (token: string) => void
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</p>
      </div>
      {rawInput === undefined ? (
        <p className="p-4 text-sm text-muted-foreground">
          No upstream data yet — run the flow once, or pin a step&apos;s output, and the values you can map from will
          appear here.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <JsonTokenView value={rawInput} onInsertToken={onInsertToken} />
        </div>
      )}
    </div>
  )
}
