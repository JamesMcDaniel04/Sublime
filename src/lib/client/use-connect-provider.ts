'use client'

import { useCallback } from 'react'

export type ConnectResult = { ok: boolean; error?: string }

type ConnectionStatus = { provider: string; status?: string }

// One POST that creates the Klavis server instance for `provider`, then drives
// the OAuth popup (when the provider needs it) and polls until the connection
// reports `active`. Resolves a plain result so callers decide how to surface it.
//
// Shared by the integrations page (manage connections) and the flow builder's
// connect-first tool pick, so the tricky popup + polling handshake lives once.
export function useConnectProvider() {
  const connect = useCallback(async (provider: string): Promise<ConnectResult> => {
    let result: { error?: string; results?: { status?: string; oauthUrl?: string }[] }
    try {
      const response = await fetch('/api/mcp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: [provider] }),
      })
      result = await response.json().catch(() => ({}))
      if (!response.ok) return { ok: false, error: result.error || 'Connection failed' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Connection failed' }
    }

    const res = result.results?.[0]
    if (res?.status === 'active') return { ok: true }

    if (res?.oauthUrl) {
      const popup = window.open(res.oauthUrl, '_blank', 'width=600,height=700')
      if (!popup) {
        return { ok: false, error: 'Your browser blocked the sign-in popup — allow popups for this site and try again.' }
      }
      return new Promise<ConnectResult>((resolve) => {
        let attempts = 0
        const timer = window.setInterval(async () => {
          attempts += 1
          try {
            const statusResponse = await fetch('/api/mcp/connections?fresh=1', { cache: 'no-store' })
            const statusData: { connections?: ConnectionStatus[] } = await statusResponse.json()
            const current = statusData.connections?.find((connection) => connection.provider === provider)
            if (current?.status === 'active') {
              window.clearInterval(timer)
              popup.close()
              resolve({ ok: true })
            } else if (attempts >= 60 || (popup.closed && attempts >= 3)) {
              // Timed out (~2 min) or the user closed the popup without finishing.
              window.clearInterval(timer)
              resolve({ ok: false, error: 'Connection was not completed.' })
            }
          } catch {
            if (attempts >= 60) {
              window.clearInterval(timer)
              resolve({ ok: false, error: "Couldn't confirm the connection." })
            }
          }
        }, 2_000)
      })
    }

    // No popup and not active: providers that authenticate in the Klavis
    // dashboard rather than via OAuth. Nothing to insert yet.
    const name = provider.charAt(0).toUpperCase() + provider.slice(1)
    return { ok: false, error: `${name} authenticates in your Klavis dashboard. Once it shows Authorized there, add the action again.` }
  }, [])

  return { connect }
}
