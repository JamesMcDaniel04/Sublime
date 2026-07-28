'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { HtmlPreview } from '@/components/ui/html-preview'
import type { Disposition, Outcome, WorkPatch } from '@/lib/goals/work-transitions'

/** Closed vocabulary so reasons are countable without an LLM. Ordered most
 *  common first — the first tap should usually be the right one. */
const SKIP_REASONS: Array<{ value: string; label: string }> = [
  { value: 'too_early', label: 'Too early' },
  { value: 'wrong_contact', label: 'Wrong contact' },
  { value: 'wrong_content', label: 'Wrong content' },
  { value: 'already_handled', label: 'Already handled' },
  { value: 'not_relevant', label: 'Not relevant' },
  { value: 'other', label: 'Other' },
]

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
  const [askingWhy, setAskingWhy] = useState(false)
  const [writingNote, setWritingNote] = useState(false)
  const [note, setNote] = useState('')

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

      {open && !askingWhy && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={copy}>
            Copy
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAskingWhy(true)}>
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

      {/* "Skipped" alone says something is wrong; the reason says what to
          change. This one extra tap is the only structured signal the
          learning layer has about why work misses. */}
      {open && askingWhy && !writingNote && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Why are you skipping it?</p>
          <div className="flex flex-wrap gap-1.5">
            {SKIP_REASONS.map((reason) => (
              <Button
                key={reason.value}
                size="sm"
                variant="outline"
                onClick={() =>
                  // "Other" is exactly where the five fixed reasons failed, so
                  // it is the one case where recording the words matters more
                  // than recording the count.
                  reason.value === 'other'
                    ? setWritingNote(true)
                    : onPatch({ disposition: 'skipped', skipReason: reason.value })
                }
              >
                {reason.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setAskingWhy(false)}>
              Never mind
            </Button>
          </div>
        </div>
      )}

      {open && writingNote && (
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground" htmlFor={`skip-note-${item.id}`}>
            What was wrong with it?
          </label>
          <textarea
            id={`skip-note-${item.id}`}
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm"
            placeholder="The account merged last week, so this is moot."
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              onClick={() =>
                onPatch({
                  disposition: 'skipped',
                  skipReason: 'other',
                  skipNote: note.trim() || null,
                })
              }
            >
              Skip it
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setWritingNote(false)
                setNote('')
              }}
            >
              Back
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
