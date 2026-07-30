'use client'

/**
 * Workspace membership: invitations, roles, suspension. Admin actions are
 * gated visually here AND independently server-side (member:manage) — hiding
 * a button and refusing the request are separate mechanisms on purpose.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { Invitation, Member } from './types'

export function MembersTab({
  isAdmin,
  members,
  invitations,
  onReload,
}: Readonly<{
  isAdmin: boolean
  members: Member[]
  invitations: Invitation[]
  onReload: () => Promise<void>
}>) {
  const [inviteEmail, setInviteEmail] = useState('')
  const [detailMember, setDetailMember] = useState<Member | null>(null)

  async function inviteMember(event: React.FormEvent) {
    event.preventDefault()
    const response = await fetch('/api/settings/members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: inviteEmail, role: 'MEMBER' }) })
    const data = await response.json(); if (!response.ok) return toast.error(data.error || 'Could not send invitation')
    setInviteEmail(''); await onReload(); toast.success('Invitation sent')
  }
  async function updateMember(member: Member, changes: Partial<Member>) {
    const response = await fetch('/api/settings/members', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: member.id, ...changes }) })
    const data = await response.json(); if (!response.ok) return toast.error(data.error || 'Could not update member')
    await onReload(); toast.success('Member updated')
  }
  async function revokeInvitation(invitation: Invitation) {
    const response = await fetch(`/api/settings/members?invitationId=${encodeURIComponent(invitation.id)}`, { method: 'DELETE' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return toast.error(data.error || 'Could not revoke invitation')
    await onReload()
    toast.success('Invitation revoked')
  }

  return (
    <Card className="max-w-3xl"><CardHeader><CardTitle>Workspace members</CardTitle></CardHeader><CardContent className="space-y-4">
      {isAdmin ? <form className="flex flex-col gap-3 sm:flex-row" onSubmit={inviteMember}><Input type="email" placeholder="colleague@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required /><Button type="submit">Invite</Button></form> : <p className="text-sm text-muted-foreground">Only workspace admins can invite or manage members.</p>}
      {invitations.length > 0 && <div className="space-y-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending invitations</p>{invitations.map((invitation) => <div key={invitation.id} className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{invitation.email}</p><p className="text-xs text-muted-foreground">{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</p></div>{isAdmin && <Button variant="outline" size="sm" onClick={() => revokeInvitation(invitation)}>Revoke</Button>}</div>)}</div>}
      {members.map((member) => <div key={member.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.name || member.email}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p></div>{isAdmin ? <><Button variant="outline" onClick={() => updateMember(member, { role: member.role === 'ADMIN' ? 'MEMBER' : 'ADMIN' })}>{member.role}</Button><Button variant="outline" onClick={() => updateMember(member, { isActive: !member.isActive })}>{member.isActive ? 'Suspend' : 'Reactivate'}</Button><Button variant="ghost" size="sm" onClick={() => setDetailMember(member)}>Owned work</Button></> : <span className="text-xs text-muted-foreground">{member.role}</span>}</div>)}
      {detailMember && (
        <MemberResourcesPanel
          member={detailMember}
          members={members}
          onClose={() => setDetailMember(null)}
        />
      )}
    </CardContent></Card>
  )
}

type OwnedResource = { id: string; name: string; type: 'flow' | 'agent' | 'goal'; updatedAt: string }

/**
 * What one member owns, and where it goes when they leave. NAMES ONLY — the
 * resource rows deliberately carry no content, and clicking one does not open
 * it: listing what someone owns solves offboarding, reading their drafts is a
 * different feature (see the admin-surfaces spec, §3.1).
 */
function MemberResourcesPanel({
  member,
  members,
  onClose,
}: Readonly<{ member: Member; members: Member[]; onClose: () => void }>) {
  const [resources, setResources] = useState<OwnedResource[] | null>(null)
  const [error, setError] = useState('')
  const [toUserId, setToUserId] = useState('')
  const [reassigning, setReassigning] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const response = await fetch(`/api/settings/members/${member.id}/resources`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) return setError(body.error || 'Could not load owned work.')
    setResources(body.resources ?? [])
  }, [member.id])
  useEffect(() => { void load() }, [load])

  // Reassignment targets: active members other than the current owner.
  const targets = members.filter((candidate) => candidate.isActive && candidate.id !== member.id)

  async function reassign(resourceIds: string[]) {
    if (!toUserId) return toast.error('Pick who the work goes to first.')
    setReassigning(true)
    try {
      const response = await fetch(`/api/settings/members/${member.id}/reassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceIds, toUserId }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(body.error || 'Could not reassign.')
      toast.success(`Reassigned ${body.reassigned} item${body.reassigned === 1 ? '' : 's'}.`)
      await load()
    } finally {
      setReassigning(false)
    }
  }

  return (
    <div className="rounded-md border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">Owned by {member.name || member.email}</p>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!resources && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {resources && resources.length === 0 && <p className="text-sm text-muted-foreground">Nothing owned — nothing to reassign.</p>}
      {resources && resources.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={toUserId}
              onChange={(event) => setToUserId(event.target.value)}
              aria-label="Reassign to"
            >
              <option value="">Reassign to…</option>
              {targets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.email}</option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              loading={reassigning}
              disabled={reassigning || !toUserId}
              onClick={() => void reassign(resources.map((resource) => resource.id))}
            >
              Reassign all {resources.length}
            </Button>
          </div>
          <div className="space-y-1.5">
            {resources.map((resource) => (
              <div key={resource.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{resource.type}</span>
                <span className="min-w-0 flex-1 truncate">{resource.name}</span>
                <span className="text-xs text-muted-foreground">{new Date(resource.updatedAt).toLocaleDateString()}</span>
                <Button variant="ghost" size="sm" disabled={reassigning || !toUserId} onClick={() => void reassign([resource.id])}>
                  Reassign
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
