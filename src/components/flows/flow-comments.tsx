'use client'

/**
 * Flow Jam comments (Spec 3): a threads panel + ephemeral reactions overlay.
 *
 * Threads anchor to a node (jump-to-node chip) or to the whole flow. The panel
 * owns its own API calls; the page passes `onChanged` so every mutation also
 * refreshes the list and broadcasts `comments-changed` to peers on the jam
 * channel (offline teammates get bell/push notifications from the API instead).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, CornerDownRight, Loader2, MapPin, MessageSquareText, Pin, RotateCcw, Send, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { jamCursorColor, type JamCanvasSpace } from '@/lib/flows/jam-presence'
import { splitMentionSegments, type MentionCandidate } from '@/lib/flows/comment-mentions'
import { cn } from '@/lib/utils'

export type CommentAnchorPoint = { space: JamCanvasSpace; x: number; y: number }

export type FlowCommentItem = {
  id: string
  parentId: string | null
  anchorNodeId: string | null
  anchorPoint: CommentAnchorPoint | null
  body: string
  resolvedAt: string | null
  createdAt: string
  author: { id: string; name: string }
  mine: boolean
}

export function useFlowComments(flowId: string, enabled: boolean) {
  const [comments, setComments] = useState<FlowCommentItem[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const response = await fetch(`/api/flows/${flowId}/comments`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.success) setComments(data.comments || [])
    } catch {
      // keep the last-known list on a transient failure
    } finally {
      setLoading(false)
    }
  }, [flowId, enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openThreadCount = comments.filter((comment) => !comment.parentId && !comment.resolvedAt).length
  return { comments, loading, refresh, openThreadCount }
}

// ── Canvas pins ──────────────────────────────────────────────────────────────

export type CommentPinData = {
  id: string
  x: number
  y: number
  color: string
  initial: string
  count: number
}

/** Open point-anchored threads in the given canvas space, as renderable pins. */
export function commentPinsFor(comments: FlowCommentItem[], space: JamCanvasSpace): CommentPinData[] {
  const replyCounts = new Map<string, number>()
  for (const comment of comments) {
    if (comment.parentId) replyCounts.set(comment.parentId, (replyCounts.get(comment.parentId) ?? 0) + 1)
  }
  return comments
    .filter((comment) => !comment.parentId && !comment.resolvedAt && comment.anchorPoint?.space === space)
    .map((comment) => ({
      id: comment.id,
      x: comment.anchorPoint!.x,
      y: comment.anchorPoint!.y,
      color: jamCursorColor(comment.author.id),
      initial: comment.author.name.trim().charAt(0).toUpperCase() || '?',
      count: 1 + (replyCounts.get(comment.id) ?? 0),
    }))
}

/**
 * Figma-style teardrop marker: round with a squared bottom-left corner that
 * points at the anchored spot. Shows the reply count once a thread grows.
 */
export function CommentPinMarker({ pin, onClick }: Readonly<{ pin: CommentPinData; onClick?: () => void }>) {
  return (
    <button
      type="button"
      aria-label={`Open comment thread (${pin.count})`}
      title={`Comment thread (${pin.count})`}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
      className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full rounded-bl-none border-2 border-background text-[11px] font-bold text-white shadow-md transition-transform hover:scale-110"
      style={{ backgroundColor: pin.color }}
    >
      {pin.count > 1 ? pin.count : pin.initial}
    </button>
  )
}

/**
 * Pins for the STACK canvas, rendered in content coordinates inside the
 * transformed wrapper (same anchor JamStackCursors uses). Counter-scaled about
 * the bottom-left corner so the tip stays on the anchored spot at any zoom.
 * (DAG-mode pins render inside DagCanvas via ViewportPortal.)
 */
export function JamStackCommentPins({ pins, zoom, onPinClick }: Readonly<{
  pins: CommentPinData[]
  zoom: number
  onPinClick: (rootId: string) => void
}>) {
  if (pins.length === 0) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-20" aria-hidden={false}>
      {pins.map((pin) => (
        <div key={pin.id} className="absolute h-0 w-0" style={{ left: pin.x, top: pin.y }}>
          <div className="absolute bottom-0 left-0" style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'bottom left' }}>
            <CommentPinMarker pin={pin} onClick={() => onPinClick(pin.id)} />
          </div>
        </div>
      ))}
    </div>
  )
}

function CommentAvatar({ userId, name }: { userId: string; name: string }) {
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ backgroundColor: jamCursorColor(userId) }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

export function CommentsPanel({
  flowId,
  open,
  onClose,
  comments,
  loading,
  canModerate,
  nodeLabels,
  selectedNodeId,
  onJumpToNode,
  onChanged,
  pendingPin = null,
  onCancelPendingPin,
  placingPin = false,
  onTogglePinPlacement,
  focusThreadId = null,
}: Readonly<{
  flowId: string
  open: boolean
  onClose: () => void
  comments: FlowCommentItem[]
  loading: boolean
  /** Flow owner: may resolve/delete anyone's thread (authors always can, theirs). */
  canModerate: boolean
  /** node id → display label, for anchor chips. */
  nodeLabels: Record<string, string>
  /** Currently selected canvas node — a new comment anchors to it by default. */
  selectedNodeId: string | null
  onJumpToNode: (nodeId: string) => void
  /** Called after any successful mutation (refresh + peer broadcast). */
  onChanged: () => void
  /** A canvas point just clicked in placement mode — the next comment pins there. */
  pendingPin?: CommentAnchorPoint | null
  onCancelPendingPin?: () => void
  /** Placement mode: the next canvas click drops a pin. */
  placingPin?: boolean
  onTogglePinPlacement?: () => void
  /** Scroll this thread into view (a pin was clicked on the canvas). */
  focusThreadId?: string | null
}>) {
  const [draft, setDraft] = useState('')
  const [anchorToSelection, setAnchorToSelection] = useState(true)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const threadRefs = useRef(new Map<string, HTMLDivElement>())
  // Workspace members power @mention autocomplete + highlighting. Loaded once
  // per panel open; the API re-parses mentions server-side regardless.
  const [members, setMembers] = useState<MentionCandidate[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/organizations/members', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        const list = (data.members || [])
          .filter((member: { name?: string | null }) => member.name?.trim())
          .map((member: { id: string; name: string }) => ({ id: member.id, name: member.name }))
        setMembers(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open])

  // A pin click on the canvas scrolls its thread into view. Scroll ONCE per
  // focus — comments.length is a dep only so a focus set before the list loads
  // still lands; without the once-guard every new comment would re-yank the
  // scroll position back to the focused thread.
  const lastFocusScrolledRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusThreadId || !open) return
    if (lastFocusScrolledRef.current === focusThreadId) return
    const element = threadRefs.current.get(focusThreadId)
    if (!element) return
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    lastFocusScrolledRef.current = focusThreadId
  }, [focusThreadId, open, comments.length])

  const mentionMatches = mentionQuery === null
    ? []
    : members.filter((member) => member.name.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 5)

  /** Trailing "@query" before the caret (no spaces) — arms the autocomplete. */
  const syncMentionQuery = (value: string, caret: number | null) => {
    const before = value.slice(0, caret ?? value.length)
    const match = /@([^\s@]*)$/.exec(before)
    setMentionQuery(match ? match[1] : null)
  }

  const applyMention = (member: MentionCandidate) => {
    const textarea = composerRef.current
    const caret = textarea?.selectionStart ?? draft.length
    const before = draft.slice(0, caret)
    const match = /@([^\s@]*)$/.exec(before)
    if (!match) return
    const start = caret - match[0].length
    const inserted = `@${member.name} `
    setDraft(draft.slice(0, start) + inserted + draft.slice(caret))
    setMentionQuery(null)
    requestAnimationFrame(() => {
      if (!textarea) return
      textarea.focus()
      const position = start + inserted.length
      textarea.setSelectionRange(position, position)
    })
  }

  const roots = comments.filter((comment) => !comment.parentId)
  const openThreads = roots.filter((comment) => !comment.resolvedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const resolvedThreads = roots.filter((comment) => Boolean(comment.resolvedAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const repliesOf = (rootId: string) => comments.filter((comment) => comment.parentId === rootId)

  const mutate = async (perform: () => Promise<Response>, failure: string) => {
    setBusy(true)
    try {
      const response = await perform()
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || failure)
        return false
      }
      onChanged()
      return true
    } catch {
      toast.error(failure)
      return false
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    const body = draft.trim()
    if (!body) return
    // Anchor priority: a freshly placed canvas pin beats the selected node.
    const anchorNodeId = !pendingPin && anchorToSelection && selectedNodeId ? selectedNodeId : undefined
    const ok = await mutate(
      () => fetch(`/api/flows/${flowId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body,
          ...(anchorNodeId ? { anchorNodeId } : {}),
          ...(pendingPin ? { anchorPoint: pendingPin } : {}),
        }),
      }),
      'Could not post the comment.',
    )
    if (ok) {
      setDraft('')
      if (pendingPin) onCancelPendingPin?.()
    }
  }

  const reply = async (rootId: string) => {
    const body = replyDraft.trim()
    if (!body) return
    const ok = await mutate(
      () => fetch(`/api/flows/${flowId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, parentId: rootId }),
      }),
      'Could not post the reply.',
    )
    if (ok) {
      setReplyDraft('')
      setReplyingTo(null)
    }
  }

  const setResolved = (id: string, resolved: boolean) => mutate(
    () => fetch(`/api/flows/${flowId}/comments`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, resolved }),
    }),
    'Could not update the thread.',
  )

  const remove = (id: string) => mutate(
    () => fetch(`/api/flows/${flowId}/comments`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
    'Could not delete the comment.',
  )

  const renderComment = (comment: FlowCommentItem, isReply = false) => (
    <div key={comment.id} className={cn('group/comment flex gap-2', isReply && 'ml-7')}>
      <CommentAvatar userId={comment.author.id} name={comment.author.name} />
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <span className="font-semibold text-foreground">{comment.author.name}</span>{' '}
          <span className="text-muted-foreground">{timeAgo(comment.createdAt)}</span>
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
          {splitMentionSegments(comment.body, members).map((segment, index) =>
            segment.mention ? (
              <span key={`${comment.id}-${index}`} className="rounded bg-indigo-50 px-0.5 font-medium text-indigo-700">{segment.text}</span>
            ) : (
              <span key={`${comment.id}-${index}`}>{segment.text}</span>
            ),
          )}
        </p>
      </div>
      {(comment.mine || canModerate) && (
        <button
          type="button"
          aria-label="Delete comment"
          title="Delete"
          disabled={busy}
          onClick={() => void remove(comment.id)}
          className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-rose-500 group-hover/comment:flex"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )

  const renderThread = (root: FlowCommentItem) => {
    const anchorLabel = root.anchorNodeId ? nodeLabels[root.anchorNodeId] : null
    const resolved = Boolean(root.resolvedAt)
    return (
      <div
        key={root.id}
        ref={(element) => {
          if (element) threadRefs.current.set(root.id, element)
          else threadRefs.current.delete(root.id)
        }}
        className={cn(
          'space-y-2 rounded-lg border p-2.5',
          resolved ? 'border-border/60 bg-muted/60 opacity-75' : 'border-border bg-card',
          focusThreadId === root.id && 'ring-2 ring-indigo-300',
        )}
      >
        {root.anchorPoint && (
          <span className="flex w-fit items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            <Pin className="h-3 w-3 shrink-0" /> Canvas pin{root.anchorPoint.space === 'dag' ? ' (Canvas view)' : ' (Stack view)'}
          </span>
        )}
        {root.anchorNodeId && (
          <button
            type="button"
            onClick={() => onJumpToNode(root.anchorNodeId!)}
            className="flex max-w-full items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100"
            title="Select this step on the canvas"
          >
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{anchorLabel || 'Removed step'}</span>
          </button>
        )}
        {renderComment(root)}
        {repliesOf(root.id).map((comment) => renderComment(comment, true))}
        <div className="flex items-center gap-1.5 pl-8">
          {replyingTo === root.id ? (
            <>
              <input
                autoFocus
                value={replyDraft}
                disabled={busy}
                onChange={(event) => setReplyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void reply(root.id)
                  if (event.key === 'Escape') setReplyingTo(null)
                }}
                placeholder="Reply…"
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-indigo-300"
              />
              <button type="button" aria-label="Send reply" disabled={busy || !replyDraft.trim()} onClick={() => void reply(root.id)} className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-background disabled:opacity-40">
                <Send className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => { setReplyingTo(root.id); setReplyDraft('') }} className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-indigo-600">
                <CornerDownRight className="h-3 w-3" /> Reply
              </button>
              {(root.mine || canModerate) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setResolved(root.id, !resolved)}
                  className={cn('ml-auto flex items-center gap-1 text-[11px] font-medium', resolved ? 'text-muted-foreground hover:text-indigo-600' : 'text-emerald-600 hover:text-emerald-700')}
                >
                  {resolved ? <><RotateCcw className="h-3 w-3" /> Reopen</> : <><Check className="h-3 w-3" /> Resolve</>}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  let composerPlaceholder = 'Comment on this flow…'
  if (pendingPin) composerPlaceholder = 'Comment on this spot…'
  else if (selectedNodeId && anchorToSelection) composerPlaceholder = 'Comment on this step…'

  if (!open) return null
  return (
    <div className="fixed bottom-4 right-4 top-20 z-40 flex w-80 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <MessageSquareText className="h-4 w-4 text-indigo-600" /> Comments
        </p>
        <div className="flex items-center gap-1">
          {onTogglePinPlacement && (
            <button
              type="button"
              aria-pressed={placingPin}
              title={placingPin ? 'Cancel pin placement' : 'Pin a comment on the canvas'}
              onClick={onTogglePinPlacement}
              className={cn(
                'flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors',
                placingPin ? 'bg-amber-100 text-amber-800' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Pin className="h-3.5 w-3.5" /> {placingPin ? 'Click the canvas…' : 'Pin'}
            </button>
          )}
          <button type="button" aria-label="Close comments" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="border-b p-3">
        {pendingPin && (
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-amber-700">
            <Pin className="h-3 w-3 shrink-0" />
            New canvas pin — your comment attaches to the clicked spot.
            <button type="button" className="ml-auto font-medium text-muted-foreground hover:text-foreground" onClick={onCancelPendingPin}>
              Cancel
            </button>
          </p>
        )}
        {!pendingPin && selectedNodeId && (
          <label className="mb-1.5 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" className="accent-indigo-600" checked={anchorToSelection} onChange={(event) => setAnchorToSelection(event.target.checked)} />
            Attach to <span className="max-w-[150px] truncate font-medium text-indigo-700">{nodeLabels[selectedNodeId] || 'selected step'}</span>
          </label>
        )}
        <div className="relative">
          {mentionMatches.length > 0 && (
            <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
              {mentionMatches.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  // Keep the textarea focused so picking doesn't blur mid-insert.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMention(member)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <CommentAvatar userId={member.id} name={member.name} />
                  <span className="truncate">{member.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <textarea
              ref={composerRef}
              value={draft}
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value)
                syncMentionQuery(event.target.value, event.target.selectionStart)
              }}
              onKeyDown={(event) => {
                // While the @mention dropdown is open, Enter/Tab pick the top
                // match and Escape dismisses — Enter only submits otherwise.
                if (mentionMatches.length > 0) {
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault()
                    applyMention(mentionMatches[0])
                    return
                  }
                  if (event.key === 'Escape') {
                    setMentionQuery(null)
                    return
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void create()
                }
              }}
              onBlur={() => setMentionQuery(null)}
              rows={2}
              placeholder={composerPlaceholder}
              className="min-h-[3rem] flex-1 resize-none rounded-md border border-border bg-background p-2 text-sm outline-none focus:border-indigo-300"
            />
            <Button size="icon" aria-label="Post comment" disabled={busy || !draft.trim()} onClick={() => void create()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {loading && <Loader2 className="mx-auto my-6 h-4 w-4 animate-spin text-muted-foreground" />}
        {!loading && roots.length === 0 && (
          <p className="py-8 text-center text-xs text-muted-foreground">No comments yet — start the discussion.</p>
        )}
        {openThreads.map(renderThread)}
        {resolvedThreads.length > 0 && (
          <>
            <p className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Resolved</p>
            {resolvedThreads.map(renderThread)}
          </>
        )}
      </div>
    </div>
  )
}
