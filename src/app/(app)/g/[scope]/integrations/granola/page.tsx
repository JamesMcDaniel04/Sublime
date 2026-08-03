'use client'

import { ScopedLink as Link } from '@/components/ui/scoped-link'
import { ArrowLeft, NotebookPen } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { GranolaKeyPanel } from '@/components/granola/granola-key-panel'
import { useCachedJson } from '@/lib/client/use-cached-json'

/**
 * Granola configuration — the page behind the integrations tile.
 *
 * Granola authenticates with a workspace API key rather than OAuth, so its
 * tile carries a configPath instead of a Connect flow, exactly like Postgres.
 */
export default function GranolaIntegrationPage() {
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
          icon={NotebookPen}
          title="Granola"
          description="Connect your Granola workspace so agents can read your meeting notes, and so recent meetings feed workspace activity. Access is read-only."
        />
      </div>
      <GranolaKeyPanel isAdmin={isAdmin} />
    </div>
  )
}
