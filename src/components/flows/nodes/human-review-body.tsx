'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, labelClass, tokenControlBase } from './field-primitives'
import { FieldPreview } from './field-preview'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function HumanReviewBody({
  node,
  update,
  tokenWiring,
  showErrors,
  previewContext,
}: {
  node: Extract<FlowNode, { type: 'humanReview' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
  previewContext?: NodeBodyProps['previewContext']
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const messageInvalid = Boolean(showErrors && !node.data.message.trim())
  const [members, setMembers] = useState<Array<{ id: string; name: string; email?: string | null; isSelf?: boolean }>>([])
  const [membersFailed, setMembersFailed] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/organizations/members', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || 'Could not load members')
        if (active) setMembers(Array.isArray(body.members) ? body.members : [])
      })
      .catch(() => {
        if (active) setMembersFailed(true)
      })
    return () => { active = false }
  }, [])
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Message <span className="text-red-500">*</span></label>
        <TokenTextEditor
          ref={registerEditor('hr.message')}
          multiline
          rows={4}
          value={node.data.message}
          labelCtx={labelCtx}
          onFocus={focusEditor('hr.message')}
          onChange={(message) => update({ ...node, data: { ...node.data, message } })}
          invalid={messageInvalid}
          className={cn(tokenControlBase, messageInvalid ? 'focus:border-red-500' : 'border-border')}
          placeholder="What should the person be asked? Their reply becomes this step's output."
          ariaLabel="Message"
        />
        <FieldPreview value={node.data.message ?? ''} ctx={previewContext} />
      </div>
      <div className="grid gap-2">
        <label className={labelClass} htmlFor="assigned-to">Assigned to</label>
        <select id="assigned-to"
          value={node.data.assigneeUserId ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, assigneeUserId: event.target.value || undefined } })}
          className={controlClass}
          aria-label="Person assigned to answer"
        >
          <option value="">Person who started the run (default)</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}{member.isSelf ? ' (you)' : ''}{member.email && member.email !== member.name ? ` — ${member.email}` : ''}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          The run pauses here until this person replies. Their reply becomes this step&apos;s output.
        </p>
        {membersFailed && <p className="text-xs text-red-600">Workspace members could not be loaded. Leave the default selected or reopen this step to retry.</p>}
      </div>
    </div>
  )
}

// MISSING_REVIEW_MESSAGE in validate.ts.
export const humanReviewModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, showErrors, previewContext }: NodeBodyProps) => (
    <HumanReviewBody node={node as Extract<FlowNode, { type: 'humanReview' }>} update={update} tokenWiring={tokenWiring} showErrors={showErrors} previewContext={previewContext} />
  ),
  defaultEditorKey: 'hr.message',
  requiredFields: ['message'],
}
