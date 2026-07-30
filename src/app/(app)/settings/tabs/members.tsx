'use client'

/**
 * Workspace membership: invitations, roles, suspension. Admin actions are
 * gated visually here AND independently server-side (member:manage) — hiding
 * a button and refusing the request are separate mechanisms on purpose.
 */

import { useState } from 'react'
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
      {members.map((member) => <div key={member.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.name || member.email}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p></div>{isAdmin ? <><Button variant="outline" onClick={() => updateMember(member, { role: member.role === 'ADMIN' ? 'MEMBER' : 'ADMIN' })}>{member.role}</Button><Button variant="outline" onClick={() => updateMember(member, { isActive: !member.isActive })}>{member.isActive ? 'Suspend' : 'Reactivate'}</Button></> : <span className="text-xs text-muted-foreground">{member.role}</span>}</div>)}
    </CardContent></Card>
  )
}
