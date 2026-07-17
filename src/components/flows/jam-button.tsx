'use client'

/**
 * The Flow Jam cluster in the builder header: live peer facepile (avatar
 * colors match each peer's canvas cursor color), voice-huddle controls, and a
 * "Jam" button that opens an org-member picker and sends invite notifications
 * (in-app toast + bell + web push, all deep-linking into this flow). Joining a
 * jam is just opening the flow — presence connects automatically.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, Headphones, Loader2, Megaphone, Mic, MicOff, PhoneOff, SmilePlus, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { jamCursorColor } from '@/lib/flows/jam-presence'
import { HUDDLE_MAX_PARTICIPANTS, huddleHasRoom } from '@/lib/flows/jam-huddle'
import { cn } from '@/lib/utils'
import { JAM_REACTION_EMOJI } from './flow-comments'
import type { JamConnectionState, JamPeer } from './use-flow-jam'

type Member = { id: string; name: string; email?: string | null; isSelf: boolean }

export type JamHuddleControls = {
  active: boolean
  joining: boolean
  muted: boolean
  /** clientId → speaking (plus 'self' for the local mic). */
  speaking: Record<string, boolean>
  /** Available microphones; labels populate once mic permission is granted. */
  mics: { deviceId: string; label: string }[]
  activeMicId: string | null
  join: () => Promise<boolean>
  leave: () => void
  toggleMute: () => void
  /** Switch microphones mid-huddle (replaceTrack — no renegotiation). */
  setMic: (deviceId: string) => Promise<boolean>
}

const CONNECTION_LABEL: Record<JamConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Live',
  'catching-up': 'Catching up…',
  degraded: 'Live edits via fallback',
  offline: 'Offline — reconnecting',
  denied: 'No access to this jam',
  unconfigured: 'Not configured on this server',
}

/** Status dot tone per state: green = live, amber = working on it, red = broken. */
function connectionTone(state: JamConnectionState): string {
  if (state === 'connected') return 'bg-emerald-500'
  if (state === 'connecting' || state === 'catching-up') return 'animate-pulse bg-amber-400'
  if (state === 'degraded') return 'bg-amber-400'
  return 'bg-rose-500'
}

function JamAvatar({
  userId,
  name,
  size = 'md',
  speaking = false,
  muted = false,
  className,
}: {
  userId: string
  name: string
  size?: 'sm' | 'md'
  speaking?: boolean
  muted?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full border-2 border-white font-bold text-white shadow-sm transition-shadow',
        size === 'md' ? 'h-7 w-7 text-[11px]' : 'h-6 w-6 text-[10px]',
        speaking && 'ring-2 ring-emerald-400',
        className,
      )}
      style={{ backgroundColor: jamCursorColor(userId) }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
      {muted && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-slate-700 text-white">
          <MicOff className="h-2 w-2" />
        </span>
      )}
    </span>
  )
}

/** Voice huddle entry point + in-huddle controls (mute, participant count, leave). */
function HuddleControl({ peers, huddle }: { peers: JamPeer[]; huddle: JamHuddleControls }) {
  const huddlePeers = peers.filter((peer) => peer.inHuddle)

  // Join failures (mic blocked, no mic, huddle full) are toasted by the hook,
  // which knows the specific reason — no generic double-toast here.
  const join = () => void huddle.join()

  if (!huddle.active) {
    const othersIn = huddlePeers.length > 0
    const full = !huddleHasRoom(huddlePeers.length)
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={huddle.joining || full}
        onClick={join}
        title={
          full ? `The huddle is full (${HUDDLE_MAX_PARTICIPANTS} people max)`
          : othersIn ? `${huddlePeers.map((peer) => peer.name).join(', ')} — join the huddle`
          : 'Start a voice huddle'
        }
        className={cn(othersIn && !full && 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800')}
      >
        {huddle.joining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Headphones className="h-4 w-4" />}
        {full ? `Huddle full · ${huddlePeers.length}` : othersIn ? `Join huddle · ${huddlePeers.length}` : 'Huddle'}
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 py-1 pl-1 pr-1.5">
      <button
        type="button"
        onClick={huddle.toggleMute}
        aria-label={huddle.muted ? 'Unmute microphone' : 'Mute microphone'}
        title={huddle.muted ? 'Unmute' : 'Mute'}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full transition-colors',
          huddle.muted ? 'bg-rose-100 text-rose-600 hover:bg-rose-200' : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200',
          !huddle.muted && huddle.speaking.self && 'ring-2 ring-emerald-400',
        )}
      >
        {huddle.muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
      </button>
      {/* Mic picker — only worth the pixels when there is actually a choice. */}
      {huddle.mics.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Choose microphone"
              title="Choose microphone"
              className="flex h-6 w-5 items-center justify-center rounded-full text-emerald-700 hover:bg-emerald-100"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 rounded-xl border-slate-200 bg-white p-1 shadow-xl">
            {huddle.mics.map((mic) => (
              <button
                key={mic.deviceId}
                type="button"
                onClick={() => void huddle.setMic(mic.deviceId)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-50',
                  mic.deviceId === huddle.activeMicId && 'font-semibold text-emerald-700',
                )}
              >
                <Mic className="h-3 w-3 shrink-0" />
                <span className="truncate">{mic.label}</span>
              </button>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <span className="px-0.5 text-xs font-semibold text-emerald-800" title={`You${huddlePeers.length ? ` + ${huddlePeers.map((peer) => peer.name).join(', ')}` : ''}`}>
        {huddlePeers.length + 1}
      </span>
      <button
        type="button"
        onClick={huddle.leave}
        aria-label="Leave huddle"
        title="Leave huddle"
        className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-white transition-colors hover:bg-rose-600"
      >
        <PhoneOff className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/**
 * Ephemeral emoji picker + spotlight request, shown while the jam is live.
 * Rendered in a portal (Radix) because the builder toolbar is an overflow-x
 * scroll container — an absolutely-positioned panel inside it gets clipped
 * under the canvas.
 */
function ReactionPicker({ onReact, onSpotlight }: { onReact: (emoji: string) => void; onSpotlight?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="h-8 w-8" aria-label="React" title="Send a reaction">
          <SmilePlus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max rounded-xl border-slate-200 bg-white p-1.5 shadow-xl">
        <div className="flex gap-0.5">
          {JAM_REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-lg transition-transform hover:scale-125 hover:bg-slate-50"
              onClick={() => { onReact(emoji); setOpen(false) }}
            >
              {emoji}
            </button>
          ))}
        </div>
        {onSpotlight && (
          <button
            type="button"
            className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-indigo-700"
            onClick={() => { onSpotlight(); setOpen(false) }}
          >
            <Megaphone className="h-3.5 w-3.5" /> Spotlight me — ask everyone to follow
          </button>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function JamButton({
  flowId,
  peers,
  connectionState,
  connectionDetail = null,
  canManage = false,
  onAccessChanged,
  followingClientId = null,
  onToggleFollow,
  huddle,
  onReact,
  onSpotlight,
}: {
  flowId: string
  peers: JamPeer[]
  connectionState: JamConnectionState
  /** WHY the connection is amber/red (last realtime failure) — an unexplained
   *  status dot is undebuggable from the UI. */
  connectionDetail?: string | null
  canManage?: boolean
  onAccessChanged?: () => void
  /** Peer currently being followed (viewport tracking), if any. */
  followingClientId?: string | null
  /** Click an avatar to follow that peer's viewport; click again to stop. */
  onToggleFollow?: (clientId: string) => void
  /** Voice huddle controls from useJamHuddle; omit to hide the huddle UI. */
  huddle?: JamHuddleControls
  /** Fire an ephemeral emoji reaction at every peer. */
  onReact?: (emoji: string) => void
  /** Ask peers to follow this viewport (they get a consent toast). */
  onSpotlight?: () => void
}) {
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
        ? `Invited ${data.invited} teammate${data.invited === 1 ? '' : 's'} — they get a live "Join jam" prompt.`
        : 'Flow Jam access updated.')
      onAccessChanged?.()
      setOpen(false)
      setSelected(new Set())
    } finally {
      setSending(false)
    }
  }

  const followedPeer = followingClientId ? peers.find((peer) => peer.clientId === followingClientId) : null

  return (
    <div className="relative flex items-center gap-2">
      {/* Live peers — avatar color matches the peer's canvas cursor. Click to
          follow that teammate's viewport. */}
      {peers.length > 0 && (
        <div className="flex -space-x-2" aria-label={`${peers.length} teammates in this jam`}>
          {peers.slice(0, 4).map((peer) => (
            <button
              key={peer.clientId}
              type="button"
              title={followingClientId === peer.clientId ? `Following ${peer.name} — click to stop` : `Follow ${peer.name}`}
              onClick={() => onToggleFollow?.(peer.clientId)}
              className={cn(
                'rounded-full transition-transform hover:-translate-y-0.5',
                followingClientId === peer.clientId && 'rounded-full ring-2 ring-indigo-500 ring-offset-1',
              )}
            >
              <JamAvatar
                userId={peer.userId}
                name={peer.name}
                speaking={peer.inHuddle && Boolean(huddle?.speaking[peer.clientId])}
                muted={peer.inHuddle && peer.huddleMuted}
              />
            </button>
          ))}
          {peers.length > 4 && (
            <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-slate-400 text-[11px] font-bold text-white shadow-sm">
              +{peers.length - 4}
            </span>
          )}
        </div>
      )}
      {followedPeer && (
        <button
          type="button"
          className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow hover:bg-indigo-700"
          onClick={() => onToggleFollow?.(followedPeer.clientId)}
        >
          Following {followedPeer.name} — stop
        </button>
      )}
      {/* An ACTIVE huddle always keeps its controls — a transient transport blip
          must never strand a hot mic with no mute/leave. Joining, by contrast,
          needs the live channel (it is the signaling rail). */}
      {huddle && (huddle.active || connectionState === 'connected') && <HuddleControl peers={peers} huddle={huddle} />}
      {onReact && connectionState === 'connected' && (
        <ReactionPicker onReact={onReact} onSpotlight={peers.length > 0 ? onSpotlight : undefined} />
      )}
      {/* The invite picker portals out (Radix) — the toolbar's overflow-x
          scroll container would otherwise clip it behind the canvas. */}
      <DropdownMenu open={open && canManage} onOpenChange={(next) => canManage && setOpen(next)}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            title={`${CONNECTION_LABEL[connectionState]}${connectionDetail ? ` — ${connectionDetail}` : ''}${canManage ? ' — manage Flow Jam access' : ''}`}
          >
            <span className={cn('h-2 w-2 rounded-full', connectionTone(connectionState))} aria-hidden="true" />
            <UserPlus className="h-4 w-4" /> Jam
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 rounded-xl border-slate-200 bg-white p-3 shadow-xl">
            <p className="text-sm font-semibold text-slate-900">Start a Flow Jam</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Invited teammates get a live prompt that drops them straight into this flow.
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-600">
              <span className={cn('h-2 w-2 rounded-full', connectionTone(connectionState))} />
              {CONNECTION_LABEL[connectionState]}
              {peers.length > 0 && <span className="text-slate-400">· {peers.length} here now</span>}
            </p>
            {connectionDetail && connectionState !== 'connected' && (
              <p className="mt-1 text-[11px] leading-snug text-slate-500">{connectionDetail}</p>
            )}
            <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
              {loading && <Loader2 className="mx-auto my-3 h-4 w-4 animate-spin text-slate-400" />}
              {!loading && members.length === 0 && (
                <p className="py-3 text-center text-xs text-slate-500">No other members yet — invite teammates from Settings.</p>
              )}
              {members.map((member) => {
                const here = peers.some((peer) => peer.userId === member.id)
                return (
                  <label key={member.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                    <input
                      type="checkbox"
                      className="accent-indigo-600"
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
                    <JamAvatar userId={member.id} name={member.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate">
                      {member.name}
                      {member.email && <span className="block truncate text-[11px] text-slate-400">{member.email}</span>}
                    </span>
                    {here && (
                      <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                        In jam
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            <Button className="mt-2 w-full" size="sm" disabled={sending} onClick={invite} loading={sending}>
              Save access {selected.size > 0 ? `(${selected.size})` : ''}
            </Button>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
