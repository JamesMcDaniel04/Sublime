'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCachedJson } from './use-cached-json'

/**
 * Subscribe to the org's private run-events Realtime topic and invoke
 * `onEvent` (debounced) whenever any run transitions. Consumers use it to
 * kick their EXISTING poll fetch immediately — the poll endpoints stay the
 * authoritative data source, realtime is only the "check now" signal. That
 * makes this strictly additive: no Supabase env, a dropped socket, or a
 * rejected join all degrade to exactly the polling behavior that exists
 * today (a lost event costs latency, never correctness).
 *
 * Server side: broadcastRunEvent (src/lib/realtime/run-events.ts) sends on
 * agent-run notify transitions and flow-run terminal/waiting writes; channel
 * access is authorized per-org by the run_events_members_can_receive policy.
 */
export function useRunEvents(onEvent: () => void, options: { enabled?: boolean; debounceMs?: number } = {}) {
  const { enabled = true, debounceMs = 400 } = options
  const { data } = useCachedJson<{ organizations?: { id: string }[] }>(enabled ? '/api/organizations' : null)
  const organizationId = data?.organizations?.[0]?.id
  // Latest-callback ref so a re-render never resubscribes the channel.
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!enabled || !organizationId) return
    let disposed = false
    let debounce: number | undefined
    // createClient throws when Supabase env is absent (local dev without
    // cloud credentials) — realtime is simply off there; polling covers it.
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
    } catch {
      return
    }

    let channel: ReturnType<typeof supabase.channel> | null = null
    const subscribe = async () => {
      // Private-channel joins are authorized against the CURRENT realtime auth
      // token; block the join on the session token instead of racing it (the
      // same "green dot takes forever" fix the jam channel needed).
      try {
        const { data: sessionData } = await supabase.auth.getSession()
        const token = sessionData.session?.access_token
        if (token) await supabase.realtime.setAuth(token)
      } catch {
        // No session — the join fails and we stay on polling.
      }
      if (disposed) return
      channel = supabase.channel(`run-events:${organizationId}`, {
        config: { private: true, broadcast: { self: false } },
      })
      channel
        .on('broadcast', { event: 'run' }, () => {
          if (disposed) return
          if (debounce !== undefined) window.clearTimeout(debounce)
          debounce = window.setTimeout(() => {
            if (!disposed) onEventRef.current()
          }, debounceMs)
        })
        .subscribe()
    }
    void subscribe()

    return () => {
      disposed = true
      if (debounce !== undefined) window.clearTimeout(debounce)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [enabled, organizationId, debounceMs])
}
