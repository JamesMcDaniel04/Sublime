'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Cable, Server } from 'lucide-react'
import { McpServersPanel } from '@/components/connections/mcp-servers-panel'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OAuthIntegrationsGrid } from './oauth-integrations-grid'

function IntegrationsTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab = tabParam === 'mcp' ? 'mcp' : 'accounts'

  const handleTabChange = (value: string) => {
    router.replace(value === 'accounts' ? '/integrations' : `/integrations?tab=${value}`, { scroll: false })
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="accounts"><Cable className="mr-2 h-4 w-4" />Integrations</TabsTrigger>
        <TabsTrigger value="mcp"><Server className="mr-2 h-4 w-4" />MCP Servers</TabsTrigger>
      </TabsList>
      <TabsContent value="accounts" className="mt-6 space-y-6">
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading integrations...</p>}>
          <OAuthIntegrationsGrid />
        </Suspense>
      </TabsContent>
      <TabsContent value="mcp" className="mt-6"><McpServersPanel /></TabsContent>
    </Tabs>
  )
}

export default function IntegrationsPage() {
  return (
    <>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Connections"
          title="Integrations"
          description="Connect the tools your agents use, link your accounts, and manage MCP servers."
        />
        <Suspense fallback={null}>
          <IntegrationsTabs />
        </Suspense>
      </div>
    </>
  )
}
