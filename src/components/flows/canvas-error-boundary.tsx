'use client'

import { Component, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Last line of defense for the flow canvas (Jam hardening): a render crash on
 * a remote-applied graph must degrade to a visible recover card — never a
 * blank white page that looks like the flow was deleted. Recovery reloads the
 * page, which refetches the server graph (the jam's durable source of truth).
 */
export class CanvasErrorBoundary extends Component<
  Readonly<{ children: ReactNode }>,
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[flow-canvas] render crashed; showing recovery card:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full min-h-[24rem] flex-1 flex-col items-center justify-center gap-3 bg-muted p-8 text-center">
        <p className="text-sm font-semibold text-foreground">The canvas hit a rendering error.</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Your flow is safe — every change is saved on the server. Reload to pick up the latest shared version.
        </p>
        <Button onClick={() => window.location.reload()}>
          <RefreshCw className="mr-1.5 h-4 w-4" /> Reload flow
        </Button>
      </div>
    )
  }
}
