'use client'

import { useEffect, useState } from 'react'
import { Clock, Globe, Repeat, Variable } from 'lucide-react'

/**
 * Variables and context: the tokens available in EVERY step, regardless of
 * what ran upstream.
 *
 * The input pane above shows upstream data, which is the answer to "what did
 * the previous step produce". It is not the answer to "what can I write here",
 * because the run's clock, the workspace's constants and the loop position are
 * available without any step having produced them — and were previously
 * discoverable only by knowing they existed.
 */

interface TokenEntry {
  token: string
  label: string
}

interface TokenGroup {
  title: string
  icon: typeof Clock
  entries: TokenEntry[]
  /** Shown instead of entries when a group is legitimately empty. */
  empty?: string
}

const CLOCK: TokenEntry[] = [
  { token: '{{now}}', label: 'When the run started, ISO 8601' },
  { token: '{{now.date}}', label: 'Just the date' },
  { token: '{{now.time}}', label: 'Just the time' },
  { token: '{{today}}', label: "Today's date in the flow's timezone" },
]

const LOOP: TokenEntry[] = [
  { token: '{{item}}', label: 'The item being processed' },
  { token: '{{loop.index}}', label: 'Which iteration, from 0' },
  { token: '{{loop.count}}', label: 'How many items in total' },
]

export function ContextTokens({ onInsertToken }: { onInsertToken: (token: string) => void }) {
  const [workspaceKeys, setWorkspaceKeys] = useState<string[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Only when opened: a builder that never expands this should not pay for
    // the request on every node it inspects.
    if (!open || workspaceKeys.length > 0) return
    let cancelled = false
    fetch('/api/workspace-variables')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { variables?: { key: string }[] } | null) => {
        if (!cancelled && body?.variables) setWorkspaceKeys(body.variables.map((entry) => entry.key))
      })
      .catch(() => {
        // A failed lookup leaves the group showing its empty note rather than
        // an error: this pane is a convenience, and it must not become the
        // reason someone cannot edit a step.
      })
    return () => { cancelled = true }
  }, [open, workspaceKeys.length])

  const groups: TokenGroup[] = [
    { title: 'Time', icon: Clock, entries: CLOCK },
    {
      title: 'Workspace',
      icon: Globe,
      entries: workspaceKeys.map((key) => ({ token: `{{workspace.${key}}}`, label: 'Workspace constant' })),
      empty: 'No workspace variables yet — add them in Settings › Workspace.',
    },
    { title: 'Loop', icon: Repeat, entries: LOOP },
    {
      title: 'Flow variables',
      icon: Variable,
      entries: [{ token: '{{var.name}}', label: 'A value a Set Variable step wrote' }],
    },
  ]

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        Variables and context
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="space-y-3 px-4 pb-4">
          {groups.map((group) => (
            <div key={group.title}>
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <group.icon className="h-3 w-3" aria-hidden="true" />
                {group.title}
              </p>
              {group.entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">{group.empty}</p>
              ) : (
                <ul className="space-y-0.5">
                  {group.entries.map((entry) => (
                    <li key={entry.token}>
                      <button
                        type="button"
                        onClick={() => onInsertToken(entry.token)}
                        className="w-full rounded px-1.5 py-1 text-left hover:bg-muted"
                        title={`Insert ${entry.token}`}
                      >
                        <code className="text-xs text-foreground">{entry.token}</code>
                        <span className="ml-2 text-xs text-muted-foreground">{entry.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
