import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { ensureFreshConnectionToken } from '@/lib/mcp/connection-token'

export const runtime = 'nodejs'

// GET /api/flows/tool-catalog — the org's MCP connections with their callable
// tools, for the flow builder's deterministic tool-step picker. Discovery is
// best-effort per connection: one unreachable server doesn't empty the list.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const connections = await prisma.mcpConnection.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    take: 25,
  })
  const catalog = await Promise.all(
    connections.map(async (conn) => {
      try {
        const fresh = await ensureFreshConnectionToken(conn)
        const client = new McpClient(mcpConfigFromConnection(fresh))
        const tools = await client.getServerTools(fresh.serverUrl)
        return {
          id: conn.id,
          name: conn.name,
          tools: tools.slice(0, 100).map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
        }
      } catch {
        return { id: conn.id, name: conn.name, tools: [] as { name: string; description: string }[] }
      }
    }),
  )
  return { success: true, connections: catalog }
})
