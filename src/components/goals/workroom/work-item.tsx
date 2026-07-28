'use client'

import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { HtmlPreview } from '@/components/ui/html-preview'
import type { Disposition, Outcome, WorkPatch } from '@/lib/goals/work-transitions'

export type WorkItemData = {
  id: string
  subject: string
  produced: string
  body: string | null
  bodyFormat: 'markdown' | 'html'
  disposition: Disposition
  outcome: Outcome
  assigneeUserId: string | null
  createdAt: string
}

/**
 * One row of the workroom.
 *
 * Every action writes a disposition as its side effect — there is no separate
 * "mark as used" step. A marking step divorced from the moment of use is a
 * chore nobody does, and a ledger full of `pending` teaches nothing.
 */
export function WorkItem({
  item,
  onPatch,
  currentUserId,
}: {
  item: WorkItemData
  onPatch: (patch: WorkPatch) => void
  currentUserId?: string
}) {
  const open = item.disposition === 'pending'

  const copy = () => {
    // Best-effort: jsdom and older browsers have no clipboard, and failing to
    // copy must not lose the disposition the click already expressed.
    if (item.body) void navigator.clipboard?.writeText(item.body)
    onPatch({ disposition: 'used' })
  }

  return (
    <li className="space-y-2 rounded-xl border bg-background/60 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{item.subject}</p>
        <p className="text-xs text-muted-foreground">{item.produced}</p>
      </div>

      {item.body && (
        <div className="max-h-40 overflow-y-auto text-sm text-muted-foreground">
          {item.bodyFormat === 'html' ? (
            <HtmlPreview html={item.body} />
          ) : (
            <Markdown>{item.body}</Markdown>
          )}
        </div>
      )}

      {open && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={copy}>
            Copy
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPatch({ disposition: 'skipped' })}
          >
            Skip
          </Button>
          {item.assigneeUserId === null && currentUserId && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onPatch({ assigneeUserId: currentUserId })}
            >
              Claim
            </Button>
          )}
        </div>
      )}
    </li>
  )
}
