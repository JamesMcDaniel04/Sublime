'use client'

/**
 * The Flow Jam entry point in the builder header: live peer avatars plus a
 * "Jam" button that opens an org-member picker and sends invite notifications
 * (in-app bell + web push). Joining a jam is just opening the flow — presence
 * connects automatically.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { JamConnectionState, JamPeer } from './use-flow-jam'

type Member = { id: string; name: string; email?: string | null; isSelf: boolean }

const AVATAR_TONES = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-cyan-500']

export function jamAvatarTone(userId: string) {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length]
}

const CONNECTION_LABEL: Record<JamConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Live',
  degraded: 'Live edits via fallback',
  offline: 'Reconnecting',
}

export function JamButton({ flowId, peers, connectionState, canManage = false, onAccessChanged }: { flowId: string; peers: JamPeer[]; connectionState: JamConnectionState; canManage?: boolean; onAccessChanged?: () => void }) {
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    Promise.all([
      fetch('/api/organizations/members', { cache: 'no-store' }).then((response) => response.json()),
      fetch(`/api/flows/${flowId}/jam`, { cache: 'no-store' }).then((response) => response.json()),
    ])
      .then(([memberData, accessData]) => {
        setMembers((memberData.members || []).filter((member: Member) => !member.isSelf))
        setSelected(new Set(accessData.userIds || []))
      })
      .catch(() => toast.error('Could not load your team.'))
      .finally(() => setLoading(false))
  }, [flowId, open])

  const invite = async () => {
    setSending(true)
    try {
      const response = await fetch(`/api/flows/${flowId}/jam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [...selected] }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not send invites.')
        return
      }
      toast.success(data.invited
        ? `Invited ${data.invited} teammate${data.invited === 1 ? '' : 's'} to the jam.`
        : 'Flow Jam access updated.')
      onAccessChanged?.()
      setOpen(false)
      setSelected(new Set())
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="relative flex items-center gap-2">
      {/* Live peers */}
      {peers.length > 0 && (
        <div className="flex -space-x-1.5" aria-label={`${peers.length} teammates in this jam`}>
          {peers.slice(0, 4).map((peer) => (
            <span
              key={peer.clientId}
              title={peer.name}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white',
                jamAvatarTone(peer.userId),
              )}
            >
              {peer.name.charAt(0).toUpperCase()}
            </span>
          ))}
          {peers.length > 4 && <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-slate-400 text-[10px] font-bold text-white">+{peers.length - 4}</span>}
        </div>
      )}
      <Button variant="outline" size="sm" onClick={() => canManage && setOpen((value) => !value)} title={canManage ? 'Manage Flow Jam access' : 'You are collaborating on this flow'}>
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            connectionState === 'connected' ? 'bg-emerald-500' : connectionState === 'connecting' ? 'animate-pulse bg-amber-400' : 'bg-rose-500',
          )}
          aria-hidden="true"
        />
        <Users className="h-4 w-4" /> Jam
      </Button>
      {open && canManage && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
            <p className="text-sm font-semibold text-slate-900">Start a Flow Jam</p>
            <p className="mt-0.5 text-xs text-slate-500">Choose exactly who can open and edit this flow with you.</p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-600">
              <span className={cn('h-2 w-2 rounded-full', connectionState === 'connected' ? 'bg-emerald-500' : 'bg-amber-400')} />
              {CONNECTION_LABEL[connectionState]}
            </p>
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {loading && <Loader2 className="mx-auto my-3 h-4 w-4 animate-spin text-slate-400" />}
              {!loading && members.length === 0 && (
                <p className="py-3 text-center text-xs text-slate-500">No other members yet — invite teammates from Settings.</p>
              )}
              {members.map((member) => (
                <label key={member.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={selected.has(member.id)}
                    onChange={(event) => {
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (event.target.checked) next.add(member.id)
                        else next.delete(member.id)
                        return next
                      })
                    }}
                  />
                  <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white', jamAvatarTone(member.id))}>
                    {member.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{member.name}</span>
                </label>
              ))}
            </div>
            <Button className="mt-2 w-full" size="sm" disabled={sending} onClick={invite} loading={sending}>
              Save access {selected.size > 0 ? `(${selected.size})` : ''}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
