'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Bot, Cable, Server } from 'lucide-react'
import { MCPIntegrationCards } from '@/components/integrations/mcp-integration-cards'
import { SlackBotCard } from '@/components/integrations/slack-bot-card'
import { McpServersPanel } from '@/components/connections/mcp-servers-panel'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OAuthIntegrationsGrid } from './oauth-integrations-grid'
import { useCachedJson } from '@/lib/client/use-cached-json'

function IntegrationsTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab = tabParam === 'accounts' ? 'accounts' : tabParam === 'mcp' ? 'mcp' : 'tools'
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'

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
        {isAdmin && <SlackBotCard />}
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
          description="Choose from the shared integration catalog, then authorize each tool with your own account. Credentials are never shared with other workspace members."
        />
        <Suspense fallback={null}>
          <IntegrationsTabs />
        </Suspense>
      </div>
    </>
  )
}
