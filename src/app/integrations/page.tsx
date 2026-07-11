'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Bot, Cable, Server } from 'lucide-react'
import { MCPIntegrationCards } from '@/components/integrations/mcp-integration-cards'
import { McpServersPanel } from '@/components/connections/mcp-servers-panel'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OAuthIntegrationsGrid } from './oauth-integrations-grid'
import { ScanProgressStrip } from './scan-progress-strip'

function IntegrationsTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab = tabParam === 'accounts' ? 'accounts' : tabParam === 'mcp' ? 'mcp' : 'tools'

  const handleTabChange = (value: string) => {
    router.replace(value === 'tools' ? '/integrations' : `/integrations?tab=${value}`, { scroll: false })
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="tools"><Bot className="mr-2 h-4 w-4" />Agent tools</TabsTrigger>
        <TabsTrigger value="accounts"><Cable className="mr-2 h-4 w-4" />Connected accounts</TabsTrigger>
        <TabsTrigger value="mcp"><Server className="mr-2 h-4 w-4" />MCP Servers</TabsTrigger>
      </TabsList>
      <TabsContent value="tools" className="mt-6"><MCPIntegrationCards /></TabsContent>
      <TabsContent value="accounts" className="mt-6 space-y-6">
        <Suspense fallback={<p className="text-sm text-gray-500">Loading integrations...</p>}>
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
        <ScanProgressStrip />
        <Suspense fallback={null}>
          <IntegrationsTabs />
        </Suspense>
      </div>
    </>
  )
}
