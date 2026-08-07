/**
 * DB-backed coverage for POST /api/flows/import: the three accepted formats,
 * secret stripping, agent materialization + ref remapping, and the rejection
 * matrix (bad JSON, unknown shape, agent export, SSRF-blocked URL).
 *
 * Follows the template-flow-e2e pattern: everything sits inside the
 * TEST_DATABASE_URL gate so the plain unit pass skips it silently.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const post = (body: unknown) =>
    new NextRequest(new URL('http://test/api/flows/import'), {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)

  test('flow import route', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { POST } = await import('../import/route')

    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    after(async () => {
      clearTestAuth()
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    await t.test('imports a portable doc: agent materialized, refs remapped, secrets dropped', async () => {
      const response = await POST(post({
        document: JSON.stringify({
          format: 'sublime.flow', version: 1, exportedAt: 'x',
          credentials: { triggerSecret: 'FOREIGN-SECRET' },
          flow: {
            name: 'Imported recap', description: 'from another org',
            trigger: { type: 'webhook', webhookSecretHash: 'h', webhookSecretEnc: 'enc' },
            graph: {
              nodes: [
                { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook', webhookSecretHash: 'h' } } },
                { id: 'write', type: 'agent', data: { agentId: 'ref-1', input: 'go' } },
              ],
              edges: [{ id: 'e1', source: 'trigger', target: 'write' }],
            },
          },
          agents: [{ ref: 'ref-1', title: 'Recapper', instructions: 'Write it', integrations: ['slack'] }],
          requirements: ['Reconnect slack.'],
        }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.success, true)
      assert.equal(body.flow.status, 'draft')
      assert.equal(body.flow.visibility, 'private')
      assert.equal(body.report.source, 'sublime-portable')
      assert.equal(body.report.createdAgents.length, 1)

      const row = await prisma.flow.findFirstOrThrow({ where: { id: body.flow.id, organizationId: seeded.organizationId } })
      assert.equal(JSON.stringify(row.trigger).includes('webhookSecretHash'), false)
      assert.equal(JSON.stringify(row).includes('FOREIGN-SECRET'), false)
      const graph = row.graph as { nodes: Array<{ type: string; data: Record<string, unknown> }> }
      const agentStep = graph.nodes.find((node) => node.type === 'agent')
      assert.equal(agentStep?.data.agentId, body.report.createdAgents[0].id)
      const agentRow = await prisma.agentTask.findFirstOrThrow({ where: { id: body.report.createdAgents[0].id, organizationId: seeded.organizationId } })
      assert.equal(agentRow.organizationId, seeded.organizationId)
    })

    await t.test('imports an n8n workflow and reports stubs', async () => {
      const response = await POST(post({
        document: JSON.stringify({
          name: 'From n8n',
          nodes: [
            { parameters: {}, id: 'a', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
            { parameters: { databaseId: 'db-1' }, id: 'b', name: 'Notion page', type: 'n8n-nodes-base.notion', typeVersion: 2, position: [200, 0] },
          ],
          connections: { Manual: { main: [[{ node: 'Notion page', type: 'main', index: 0 }]] } },
        }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.report.source, 'n8n')
      assert.equal(body.report.stubbedNodes.length, 1)
    })

    await t.test('n8n AI-agent cluster materializes an agent with model + integrations', async () => {
      const response = await POST(post({
        document: JSON.stringify({
          name: 'Triage',
          nodes: [
            { parameters: {}, id: 'a', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
            {
              parameters: { promptType: 'auto', text: '={{ $json.chatInput }}', options: { systemMessage: 'Triage tickets.' } },
              id: 'b', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [200, 0],
            },
            { parameters: { model: { __rl: true, mode: 'list', value: 'claude-sonnet-4-6' } }, id: 'c', name: 'Model', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.5, position: [100, 150] },
            { parameters: {}, id: 'd', name: 'Gmail', type: 'n8n-nodes-base.gmailTool', typeVersion: 2.2, position: [250, 150] },
          ],
          connections: {
            Manual: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
            Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
            Gmail: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
          },
        }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.report.createdAgents.length, 1)
      const agentRow = await prisma.agentTask.findFirstOrThrow({
        where: { id: body.report.createdAgents[0].id, organizationId: seeded.organizationId },
      })
      assert.equal(agentRow.objective, 'Triage tickets.')
      const metadata = agentRow.metadata as { model?: string; integrations?: string[] }
      assert.equal(metadata.model, 'claude-sonnet-4-6')
      assert.deepEqual(metadata.integrations, ['gmail'])
      // The graph's agent step points at the created agent.
      const graph = (await prisma.flow.findFirstOrThrow({ where: { id: body.flow.id, organizationId: seeded.organizationId } }))
        .graph as { nodes: Array<{ type: string; data: Record<string, unknown> }> }
      assert.equal(graph.nodes.find((node) => node.type === 'agent')?.data.agentId, agentRow.id)
    })

    await t.test('multi-trigger n8n workflows create sibling flows with credential groups persisted', async () => {
      const response = await POST(post({
        document: JSON.stringify({
          name: 'Two Doors',
          nodes: [
            { parameters: { path: 'a' }, id: 'w1', name: 'Door A', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
            { parameters: { path: 'b' }, id: 'w2', name: 'Door B', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 200] },
            {
              parameters: { method: 'GET', url: 'https://api.example.com/x', authentication: 'predefinedCredentialType', nodeCredentialType: 'gongApi' },
              id: 'h1', name: 'Shared fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 100],
            },
          ],
          connections: {
            'Door A': { main: [[{ node: 'Shared fetch', type: 'main', index: 0 }]] },
            'Door B': { main: [[{ node: 'Shared fetch', type: 'main', index: 0 }]] },
          },
        }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.report.additionalFlows.length, 1)
      assert.match(body.report.additionalFlows[0].name, /Door B/)
      assert.equal(body.report.credentialGroups.length, 1)
      const sibling = await prisma.flow.findFirstOrThrow({
        where: { id: body.report.additionalFlows[0].id, organizationId: seeded.organizationId },
      })
      assert.equal(sibling.status, 'DRAFT')
      const metadata = sibling.metadata as { importedCredentialGroups?: unknown[] }
      assert.equal(metadata.importedCredentialGroups?.length, 1)
    })

    await t.test('imports the builder bare download shape', async () => {
      const response = await POST(post({
        document: JSON.stringify({
          name: 'Plain download', description: '', version: 2, exportedAt: 'x',
          graph: {
            nodes: [
              { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
              { id: 'wait', type: 'wait', data: { amount: 1, unit: 'minutes' } },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'wait' }],
          },
        }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.report.source, 'sublime-download')
      assert.equal(body.flow.stepCount, 1)
    })

    await t.test('400 on invalid JSON', async () => {
      const response = await POST(post({ document: 'not json {' }))
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 'INVALID_JSON')
    })

    await t.test('400 on unrecognized shape', async () => {
      const response = await POST(post({ document: JSON.stringify({ hello: 'world' }) }))
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 'UNRECOGNIZED_FORMAT')
    })

    await t.test('400 AGENT_EXPORT for a sublime.agent doc', async () => {
      const response = await POST(post({ document: JSON.stringify({ format: 'sublime.agent', version: 1 }) }))
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 'AGENT_EXPORT')
    })

    await t.test('URL mode rejects private addresses without fetching', async () => {
      const response = await POST(post({ url: 'https://127.0.0.1/flow.json' }))
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 'URL_NOT_ALLOWED')
    })

    await t.test('rejects both document and url', async () => {
      const response = await POST(post({ document: '{}', url: 'https://example.com/f.json' }))
      assert.equal(response.status, 400)
    })
  })
}
