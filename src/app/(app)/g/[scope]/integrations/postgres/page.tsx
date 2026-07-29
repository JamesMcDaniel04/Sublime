'use client'

import { ScopedLink as Link } from '@/components/ui/scoped-link'
import { ArrowLeft, Database } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { PostgresConnectionsPanel } from '@/components/postgres/postgres-connections-panel'
import { useCachedJson } from '@/lib/client/use-cached-json'

/**
 * PostgreSQL configuration — the page behind the integrations tile.
 *
 * An org connects several named databases rather than one account, which is
 * more than a Connect/Disconnect card can express, so the tile links here.
 * The panel itself is shared with the in-place connect dialog on the goal
 * wizard, so both surfaces stay identical.
 */
export default function PostgresIntegrationPage() {
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href="/integrations"><ArrowLeft className="mr-1.5 h-4 w-4" />Integrations</Link>
        </Button>
        <PageHeader
          eyebrow="Connections"
          icon={Database}
          title="PostgreSQL"
          description="Connect your databases so agents, flows, and goals can read from them. Queries are read-only unless you enable writes on a database, and every write pauses for your approval."
        />
      </div>
      <PostgresConnectionsPanel isAdmin={isAdmin} />
    </div>
  )
}
