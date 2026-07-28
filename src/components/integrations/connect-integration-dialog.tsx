'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Nango, { type ConnectUI } from '@nangohq/frontend'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { PostgresConnectionsPanel } from '@/components/postgres/postgres-connections-panel'

/**
 * Connect an integration WITHOUT leaving the page you were on.
 *
 * The goal wizard and the agent bundle both used to send you to /integrations
 * and abandon whatever you were setting up. This brings the configuration to
 * the user instead — and it is one component so the two surfaces cannot drift.
 *
 * How a given integration connects is not uniform, so each maps to a strategy:
 *
 *   inline   — the whole configuration fits in this dialog (Postgres).
 *   apiKey   — a single secret, saved to the credential vault (Stripe).
 *   nango    — hand off to Nango's own embedded Connect UI, then poll for the
 *              connection to appear (its listing is eventually consistent).
 *   redirect — Google blocks embedded consent, so these must take over the
 *              page. The dialog says so plainly rather than opening a popup
 *              that silently fails.
 */

type Strategy =
  | { kind: 'inline' }
  | { kind: 'apiKey'; credentialName: string; placeholder: string; help: string }
  | { kind: 'nango'; integrationId: string }
  | { kind: 'redirect'; service: string }

type Target = { key: string; label: string; slug: string | null; strategy: Strategy }

/**
 * Every connectable thing the goal wizard and agent bundles can ask for,
 * keyed by BOTH the metric-source key (`google_sheets`) and the connector
 * registry key (`sheets`) so either caller resolves without a translation
 * layer in between.
 */
const TARGETS: Record<string, Target> = {
  postgres: { key: 'postgres', label: 'Postgres', slug: 'postgresql', strategy: { kind: 'inline' } },
  stripe: {
    key: 'stripe',
    label: 'Stripe',
    slug: 'stripe',
    strategy: {
      kind: 'apiKey',
      credentialName: 'Stripe',
      placeholder: 'sk_live_…',
      help: 'Create a restricted key with read access to the data your goal measures. Stored encrypted; never shown again.',
    },
  },
  hubspot: { key: 'hubspot', label: 'HubSpot', slug: 'hubspot', strategy: { kind: 'nango', integrationId: 'hubspot' } },
  salesforce: { key: 'salesforce', label: 'Salesforce', slug: 'salesforce', strategy: { kind: 'nango', integrationId: 'salesforce' } },
  slack: { key: 'slack', label: 'Slack', slug: 'slack', strategy: { kind: 'nango', integrationId: 'slack' } },
  slack_assisted: { key: 'slack_assisted', label: 'Slack', slug: 'slack', strategy: { kind: 'nango', integrationId: 'slack' } },
  github: { key: 'github', label: 'GitHub', slug: 'github', strategy: { kind: 'nango', integrationId: 'github' } },
  intercom: { key: 'intercom', label: 'Intercom', slug: 'intercom', strategy: { kind: 'nango', integrationId: 'intercom' } },
  google_sheets: { key: 'google_sheets', label: 'Google Sheets', slug: 'googlesheets', strategy: { kind: 'redirect', service: 'google-sheets' } },
  sheets: { key: 'sheets', label: 'Google Sheets', slug: 'googlesheets', strategy: { kind: 'redirect', service: 'google-sheets' } },
  google_analytics: { key: 'google_analytics', label: 'Google Analytics', slug: 'googleanalytics', strategy: { kind: 'redirect', service: 'google-analytics' } },
  analytics: { key: 'analytics', label: 'Google Analytics', slug: 'googleanalytics', strategy: { kind: 'redirect', service: 'google-analytics' } },
  gmail: { key: 'gmail', label: 'Gmail', slug: 'gmail', strategy: { kind: 'redirect', service: 'google-mail' } },
  gmail_assisted: { key: 'gmail_assisted', label: 'Gmail', slug: 'gmail', strategy: { kind: 'redirect', service: 'google-mail' } },
  calendar: { key: 'calendar', label: 'Google Calendar', slug: 'googlecalendar', strategy: { kind: 'redirect', service: 'google-calendar' } },
  drive: { key: 'drive', label: 'Google Drive', slug: 'googledrive', strategy: { kind: 'redirect', service: 'google-drive' } },
}

/** True when this integration can be connected in place (i.e. is worth a dialog). */
export function canConnectInline(source: string): boolean {
  return Boolean(TARGETS[source.toLowerCase()])
}

export function ConnectIntegrationDialog({
  source,
  open,
  onOpenChange,
  onConnected,
}: {
  /** A metric-source key ('google_sheets') or a connector key ('sheets'). */
  source: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired once the connection is confirmed, so the caller can refresh. */
  onConnected?: () => void
}) {
  const target = TARGETS[source.toLowerCase()]
  const [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const connectUIRef = useRef<ConnectUI | null>(null)

  useEffect(() => () => { connectUIRef.current?.close(); connectUIRef.current = null }, [])

  /**
   * Nango's connection listing is eventually consistent: right after the
   * Connect UI reports success, status often does not include the new
   * connection yet. Poll with backoff rather than making the user refresh.
   */
  const confirmNango = useCallback(async (integrationId: string) => {
    for (const delayMs of [0, 1000, 2000, 4000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      const response = await fetch('/api/nango/status?refresh=1', { cache: 'no-store' }).catch(() => null)
      const body = await response?.json().catch(() => ({}))
      if (body?.connections?.[integrationId]?.connected) return true
    }
    return false
  }, [])

  const startNango = async (integrationId: string) => {
    setBusy(true)
    try {
      const connectUI = new Nango().openConnectUI({
        ...(process.env.NEXT_PUBLIC_NANGO_CONNECT_URL ? { baseURL: process.env.NEXT_PUBLIC_NANGO_CONNECT_URL } : {}),
        onEvent: (event) => {
          if (event.type === 'connect') {
            connectUIRef.current = null
            setBusy(false)
            void confirmNango(integrationId).then((connected) => {
              if (connected) {
                toast.success(`${target?.label ?? integrationId} connected`)
                onConnected?.()
                onOpenChange(false)
              }
            })
          } else if (event.type === 'close') {
            connectUIRef.current = null
            setBusy(false)
          } else if (event.type === 'error') {
            toast.error(event.payload.errorMessage || 'Unable to connect account')
          }
        },
      })
      connectUIRef.current = connectUI

      const response = await fetch('/api/nango/session-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId }),
      })
      const body = await response.json()
      if (!response.ok || !body.sessionToken) {
        connectUI.close()
        connectUIRef.current = null
        throw new Error(body.error || 'Unable to start the connection flow')
      }
      connectUI.setSessionToken(body.sessionToken)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to connect account')
      setBusy(false)
    }
  }

  const saveApiKey = async (strategy: Extract<Strategy, { kind: 'apiKey' }>) => {
    setBusy(true)
    try {
      const response = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: strategy.credentialName, type: 'bearer', token: apiKey.trim() }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not save the key.')
      toast.success(`${target?.label} connected.`)
      setApiKey('')
      onConnected?.()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the key.')
    } finally {
      setBusy(false)
    }
  }

  if (!target) return null

  const body = (() => {
    switch (target.strategy.kind) {
      case 'inline':
        return (
          <PostgresConnectionsPanel
            compact
            onConnected={(connections) => {
              if (connections.length > 0) onConnected?.()
            }}
          />
        )

      case 'apiKey': {
        const strategy = target.strategy
        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="connect-api-key">API key</Label>
              <Input
                id="connect-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={strategy.placeholder}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{strategy.help}</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void saveApiKey(strategy)} loading={busy} disabled={!apiKey.trim()}>
                Connect {target.label}
              </Button>
            </div>
          </div>
        )
      }

      case 'nango': {
        const { integrationId } = target.strategy
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sign in to {target.label} and choose what Sublime may access. You will come straight back here.
            </p>
            <div className="flex justify-end">
              <Button onClick={() => void startNango(integrationId)} loading={busy}>
                Connect {target.label}
              </Button>
            </div>
          </div>
        )
      }

      case 'redirect': {
        const { service } = target.strategy
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Google requires its consent screen to open in a full page, so this will leave Sublime briefly and return
              you to this page when you are done.
            </p>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  // Come back to wherever this dialog was opened from.
                  const returnTo = `${window.location.pathname}${window.location.search}`
                  sessionStorage.setItem('sublime:connect-return', returnTo)
                  window.location.href = `/api/google/oauth/start?service=${encodeURIComponent(service)}`
                }}
              >
                <ExternalLink className="mr-2 h-4 w-4" />Continue to Google
              </Button>
            </div>
          </div>
        )
      }
    }
  })()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IntegrationLogo slug={target.slug ?? target.key} name={target.label} />
            Connect {target.label}
          </DialogTitle>
          <DialogDescription>
            Connect it here and keep going — you will not lose what you have set up on this page.
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}
