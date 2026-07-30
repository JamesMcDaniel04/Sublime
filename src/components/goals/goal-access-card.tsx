'use client'

/**
 * Who can see this goal — the admin-only Access control on the goal detail
 * page. Drives the /api/goals/[id]/members endpoints (piece C stage 2); this
 * card is purely a front end over that tested API.
 *
 * Personal goals never render this: ownerUserId already restricts them, and
 * the API refuses them with PERSONAL_GOAL anyway.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useCachedJson } from '@/lib/client/use-cached-json'

type GoalMemberRow = { userId: string }
type WorkspaceMember = { id: string; name: string | null; email: string | null; isActive: boolean }

export function GoalAccessCard({ goalId }: Readonly<{ goalId: string }>) {
  // The profile fetch is how the card decides to render at all — same pattern
  // as the integrations grid. Presentation only: the API refuses non-admins
  // independently (goal:restrict).
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'

  const [access, setAccess] = useState<'workspace' | 'restricted' | null>(null)
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [accessResponse, membersResponse] = await Promise.all([
      fetch(`/api/goals/${goalId}/members`, { cache: 'no-store' }),
      fetch('/api/settings/members', { cache: 'no-store' }),
    ])
    // A 403/404 here just means "not yours to manage" — render nothing.
    if (!accessResponse.ok) return
    const accessBody = await accessResponse.json().catch(() => ({}))
    setAccess(accessBody.access ?? 'workspace')
    setMemberIds((accessBody.members ?? []).map((row: GoalMemberRow) => row.userId))
    if (membersResponse.ok) {
      const membersBody = await membersResponse.json().catch(() => ({}))
      setWorkspaceMembers(membersBody.members ?? [])
    }
  }, [goalId])

  useEffect(() => {
    if (isAdmin) void load()
  }, [isAdmin, load])

  if (!isAdmin || access === null) return null

  async function setRestricted(restricted: boolean) {
    setSaving(true)
    try {
      const response = await fetch(`/api/goals/${goalId}/members`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access: restricted ? 'restricted' : 'workspace' }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(body.error || 'Could not change access.')
      setAccess(restricted ? 'restricted' : 'workspace')
      toast.success(restricted ? 'Goal restricted — only listed members and admins can see it.' : 'Goal visible to the whole workspace.')
    } finally {
      setSaving(false)
    }
  }

  async function toggleMember(userId: string, include: boolean) {
    const previous = memberIds
    setMemberIds(include ? [...memberIds, userId] : memberIds.filter((id) => id !== userId))
    const response = include
      ? await fetch(`/api/goals/${goalId}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        })
      : await fetch(`/api/goals/${goalId}/members?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' })
    if (!response.ok) {
      setMemberIds(previous)
      const body = await response.json().catch(() => ({}))
      toast.error(body.error || 'Could not update goal members.')
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Lock className="h-4 w-4" />Access</CardTitle>
        <CardDescription>
          Restricted goals disappear for everyone except listed members and workspace admins — including from search, roll-ups, and the goal switcher.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Restrict this goal</p>
            <p className="text-xs text-muted-foreground">
              {access === 'restricted' ? 'Hidden from non-members. They see nothing — not even that it exists.' : 'Visible to the whole workspace.'}
            </p>
          </div>
          <Switch checked={access === 'restricted'} disabled={saving} onCheckedChange={(checked) => void setRestricted(checked)} />
        </div>
        {access === 'restricted' && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Who can see it</p>
            {workspaceMembers.filter((member) => member.isActive).map((member) => {
              const included = memberIds.includes(member.id)
              return (
                <div key={member.id} className="flex items-center justify-between gap-3 rounded-md border p-2.5">
                  <p className="min-w-0 flex-1 truncate text-sm">{member.name || member.email}</p>
                  <Button
                    variant={included ? 'outline' : 'ghost'}
                    size="sm"
                    onClick={() => void toggleMember(member.id, !included)}
                  >
                    {included ? 'Remove' : 'Add'}
                  </Button>
                </div>
              )
            })}
            {memberIds.length === 0 && (
              <p className="text-xs text-muted-foreground">No members yet — only workspace admins can see this goal.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
