'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Cable, KeyRound, Server } from 'lucide-react'
import { McpServersPanel } from '@/components/connections/mcp-servers-panel'
import { CredentialsPanel } from '@/components/credentials/credentials-panel'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OAuthIntegrationsGrid } from './oauth-integrations-grid'

function IntegrationsTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab = tabParam === 'mcp' ? 'mcp' : tabParam === 'credentials' ? 'credentials' : 'accounts'

  // The native Google OAuth callback lands back here with a result param —
  // surface it once, then strip it from the URL.
  const connectedParam = searchParams.get('connected')
  const errorParam = searchParams.get('error')
  useEffect(() => {
    if (!connectedParam && !errorParam) return
    if (connectedParam) toast.success(`${connectedParam === 'gmail' ? 'Gmail' : connectedParam} connected`)
    if (errorParam) toast.error(`Connection failed: ${errorParam.replaceAll('_', ' ')}`)
    router.replace('/integrations', { scroll: false })
  }, [connectedParam, errorParam, router])

  const handleTabChange = (value: string) => {
    router.replace(value === 'accounts' ? '/integrations' : `/integrations?tab=${value}`, { scroll: false })
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="accounts"><Cable className="mr-2 h-4 w-4" />Integrations</TabsTrigger>
        <TabsTrigger value="mcp"><Server className="mr-2 h-4 w-4" />MCP Servers</TabsTrigger>
        <TabsTrigger value="credentials"><KeyRound className="mr-2 h-4 w-4" />Credentials</TabsTrigger>
      </TabsList>
      <TabsContent value="accounts" className="mt-6 space-y-6">
        <Suspense
          fallback={
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={`integration-skeleton-${i}`} className="h-40 rounded-xl" />
              ))}
            </div>
          }
        >
          <OAuthIntegrationsGrid />
        </Suspense>
      </TabsContent>
      <TabsContent value="mcp" className="mt-6"><McpServersPanel /></TabsContent>
      <TabsContent value="credentials" className="mt-6"><CredentialsPanel /></TabsContent>
    </Tabs>
  )
}

export default function IntegrationsPage() {
  return (
    <>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Connections"
          icon={Cable}
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
