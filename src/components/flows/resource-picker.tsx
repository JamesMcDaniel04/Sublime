'use client'

import { useState } from 'react'
import { List } from 'lucide-react'
import { pickerRows } from '@/lib/flows/picker-rows'

/**
 * "Pick from a list" — run a READ action on this connection and show what it
 * returns, so a step's argument can be filled from a real value instead of a
 * pasted id.
 *
 * The action list offered here is filtered to `risk === 'read'` before the
 * request is made. That is a convenience, not the control: the server refuses
 * non-read planes and write tools independently
 * (`src/lib/flows/tool-options.ts`), because a client-side filter protects
 * nobody. Both exist so the common case never even offers a dangerous option.
 *
 * Collapsed by default — most steps are configured by typing, and an
 * always-open panel that fires network calls on a live connection is worse
 * than one the user opens deliberately.
 */
export function ResourcePicker({
  connectionId,
  tools,
  onPick,
}: {
  connectionId: string
  /** Read-only actions on this connection, already filtered by the caller. */
  tools: { name: string; description?: string }[]
  /** Called with a chosen cell value, to drop into the argument being edited. */
  onPick?: (value: string) => void
}) {
  const [tool, setTool] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [table, setTable] = useState<ReturnType<typeof pickerRows> | null>(null)

  if (tools.length === 0) return null

  const load = async () => {
    if (!tool) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/flows/tool-options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId, toolName: tool }),
      }).then((r) => r.json())
      if (!response?.success) {
        // Surface the server's own refusal text — it names WHY (an MCP
        // connection cannot classify writes, a flow step would run the flow)
        // which a generic message would throw away.
        setError(response?.error || 'Could not load the list.')
        setTable(null)
      } else {
        setTable(pickerRows(response.items as unknown[]))
      }
    } catch {
      setError('Could not load the list.')
      setTable(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <details className="rounded-lg border border-border/70 p-2">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <List className="h-3.5 w-3.5" aria-hidden /> Pick from a list
      </summary>
      <div className="mt-2 space-y-2">
        <div className="flex gap-2">
          <select
            aria-label="Read action to list"
            className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs"
            value={tool}
            onChange={(event) => setTool(event.target.value)}
          >
            <option value="">Choose a read action…</option>
            {tools.map((entry) => (
              <option key={entry.name} value={entry.name}>{entry.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="h-8 rounded-md border border-input px-3 text-xs font-medium disabled:opacity-50"
            disabled={!tool || loading}
            onClick={load}
          >
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>

        {error && <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">{error}</p>}

        {table && table.rows.length === 0 && !error && (
          <p className="px-1 text-xs text-muted-foreground">That action returned no items.</p>
        )}

        {table && table.rows.length > 0 && (
          <div className="max-h-48 overflow-auto rounded-md border border-border/70">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>{table.headers.map((header) => <th key={header} className="px-2 py-1 font-medium">{header}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.map((row, index) => (
                  <tr key={index} className="border-t border-border/70">
                    {table.headers.map((header) => (
                      <td key={header} className="px-2 py-1 align-top">
                        {onPick && row[header] ? (
                          <button
                            type="button"
                            className="max-w-[16rem] truncate text-left underline decoration-dotted underline-offset-2 hover:text-foreground"
                            title={`Use "${row[header]}"`}
                            onClick={() => onPick(row[header])}
                          >
                            {row[header]}
                          </button>
                        ) : (
                          <span className="block max-w-[16rem] truncate">{row[header] ?? ''}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  )
}
