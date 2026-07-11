'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * /connections folded into /integrations as the "MCP Servers" tab. This
 * redirect keeps every existing deep link working — especially the MCP OAuth
 * start/callback routes, which land the browser back on /connections with
 * `connected`/`error` query params that the panel reads.
 */
function ConnectionsRedirect() {
  const router = useRouter()
  const searchParams = useSearchParams()
  useEffect(() => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', 'mcp')
    router.replace(`/integrations?${params.toString()}`)
  }, [router, searchParams])
  return null
}

export default function ConnectionsPage() {
  return (
    <Suspense fallback={null}>
      <ConnectionsRedirect />
    </Suspense>
  )
}
