/**
 * Workspace file repository, end to end against a real Postgres:
 *   POST /api/knowledge (JSON note)  → GET /api/knowledge?source=repository
 *   GET/PUT /api/knowledge/[id]      → edit in place keeps the id
 *   buildWorkspaceFileTools          → the agent-facing list/read tools see
 *                                      exactly what the viewer scope allows
 *   DELETE /api/knowledge            → gone from both surfaces
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key-0123456789abcdef01'

  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let agentId: string

  const json = (method: string, path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)
  const get = (path: string) => new NextRequest(new URL(`http://test${path}`))

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
    const agent = await prisma.agentTask.create({
      data: { description: 'reader', objective: 'read files', status: 'ACTIVE', agentType: 'CUSTOM', organizationId, userId },
    })
    agentId = agent.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  let noteId: string

  test('a Markdown note lands in the repository and lists there', async () => {
    const { POST, GET } = await import('../knowledge/route')
    const created = await POST(json('POST', '/api/knowledge', {
      title: 'Onboarding playbook',
      content: '# Onboarding\n\n1. Kick-off call within two days.\n2. Share the welcome pack.',
    }))
    assert.equal(created.status, 200, await created.clone().text())
    const body = await created.json()
    assert.equal(body.document.sourceType, 'manual')
    assert.equal(body.document.filename, 'onboarding-playbook.md')
    noteId = body.document.id

    const listed = await GET(get('/api/knowledge?source=repository'))
    assert.equal(listed.status, 200)
    const list = await listed.json()
    const row = list.documents.find((d: any) => d.id === noteId)
    assert.ok(row, 'note is listed')
    assert.equal(row.title, 'Onboarding playbook')
    assert.equal(row.visibility, 'organization')
    assert.equal(row.canEdit, true)
  })

  test('the note opens with its body, and an edit keeps the same id', async () => {
    const { GET, PUT } = await import('../knowledge/[id]/route')
    const opened = await GET(get(`/api/knowledge/${noteId}`))
    assert.equal(opened.status, 200, await opened.clone().text())
    const doc = (await opened.json()).document
    assert.match(doc.content, /Kick-off call/)
    assert.equal(doc.canEdit, true)

    const edited = await PUT(json('PUT', `/api/knowledge/${noteId}`, {
      title: 'Onboarding playbook v2',
      content: '# Onboarding v2\n\n1. Kick-off call within ONE day.',
    }))
    assert.equal(edited.status, 200, await edited.clone().text())

    const reopened = await (await GET(get(`/api/knowledge/${noteId}`))).json()
    assert.equal(reopened.document.id, noteId)
    assert.equal(reopened.document.title, 'Onboarding playbook v2')
    assert.match(reopened.document.content, /ONE day/)
    assert.doesNotMatch(reopened.document.content, /two days/)
    const chunks = await prisma.knowledgeChunk.count({ where: { documentId: noteId, organizationId } })
    assert.ok(chunks >= 1, 're-chunked')

    const download = await GET(get(`/api/knowledge/${noteId}?download=1`))
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="onboarding-playbook.md"')
    assert.match(await download.text(), /ONE day/)
  })

  test('agent tools list and read the file, page long bodies, and refuse ambiguity', async () => {
    const { buildWorkspaceFileTools } = await import('@/lib/knowledge/file-tools')
    const toolset = await buildWorkspaceFileTools({ organizationId, agentId, userId })
    assert.equal(toolset.fileCount, 1)
    assert.deepEqual(toolset.tools.map((t) => t.name), ['list_workspace_files', 'read_workspace_file'])
    assert.match(toolset.promptHint, /1 reference file /)

    const listed = (await toolset.execute.list_workspace_files({})) as { files: Array<{ id: string; title: string }> }
    assert.equal(listed.files[0].id, noteId)

    const read = (await toolset.execute.read_workspace_file({ file: 'onboarding' })) as { id: string; content: string; truncated: boolean }
    assert.equal(read.id, noteId)
    assert.match(read.content, /ONE day/)
    assert.equal(read.truncated, false)

    const missing = (await toolset.execute.read_workspace_file({ file: 'nope' })) as { error: string }
    assert.match(missing.error, /No workspace file matches/)

    // Listing pages: a page past the end is empty and reports no next page,
    // and a file is still readable by name even when it is not on the page.
    const page = (await toolset.execute.list_workspace_files({ offset: 1 })) as { files: unknown[]; total: number; nextOffset: number | null }
    assert.equal(page.files.length, 0)
    assert.equal(page.total, 1)
    assert.equal(page.nextOffset, null)
    const byName = (await toolset.execute.read_workspace_file({ file: 'onboarding-playbook.md' })) as { id: string }
    assert.equal(byName.id, noteId)
  })

  test('a file that expires mid-run stops being listable and readable on the next call', async () => {
    const { storeKnowledge } = await import('@/lib/knowledge/store')
    // Stored with a comfortable expiry so ingestion time can never eat the
    // window; the short fuse is set only once the toolset has been built.
    const expiring = await storeKnowledge({
      organizationId, userId, sourceType: 'upload', title: 'Ephemeral', filename: 'ephemeral.md',
      content: 'gone soon', visibility: 'organization', retentionPolicy: 'expiring', expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    assert.ok(expiring.id)
    const { buildWorkspaceFileTools } = await import('@/lib/knowledge/file-tools')
    // Built while the file is alive — the scope must not be frozen here.
    const toolset = await buildWorkspaceFileTools({ organizationId, agentId, userId })
    assert.equal(toolset.fileCount, 2)
    await prisma.knowledgeDocument.update({
      where: { id: expiring.id, organizationId },
      data: { expiresAt: new Date(Date.now() + 300) },
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const listed = (await toolset.execute.list_workspace_files({})) as { files: Array<{ id: string }>; total: number }
    assert.equal(listed.total, 1)
    assert.equal(listed.files.some((f) => f.id === expiring.id), false, 'expired file is not listed')
    const read = (await toolset.execute.read_workspace_file({ file: 'ephemeral.md' })) as { error?: string }
    assert.match(read.error ?? '', /No workspace file matches/)
    await prisma.knowledgeDocument.deleteMany({ where: { id: expiring.id, organizationId } })
  })

  test('a private note from another user is invisible to this agent and this viewer', async () => {
    const { storeKnowledge } = await import('@/lib/knowledge/store')
    const other = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true } })
    const stored = await storeKnowledge({
      organizationId, userId: other.id, sourceType: 'manual', title: 'Secret', filename: 'secret.md',
      content: 'private things', visibility: 'private',
    })
    assert.ok(stored.id)
    const { buildWorkspaceFileTools } = await import('@/lib/knowledge/file-tools')
    const toolset = await buildWorkspaceFileTools({ organizationId, agentId, userId })
    assert.equal(toolset.fileCount, 1, 'only the workspace note is readable')
    const { GET } = await import('../knowledge/[id]/route')
    assert.equal((await GET(get(`/api/knowledge/${stored.id}`))).status, 404)
    const { PUT } = await import('../knowledge/[id]/route')
    assert.equal((await PUT(json('PUT', `/api/knowledge/${stored.id}`, { title: 'x' }))).status, 403)
  })

  test('auto-captured knowledge is never editable through the repository', async () => {
    const { storeKnowledge } = await import('@/lib/knowledge/store')
    const captured = await storeKnowledge({
      organizationId, userId, sourceType: 'agent_run', sourceId: 'run-1', title: 'Run summary',
      content: 'what the agent did', visibility: 'organization',
    })
    const { PUT, GET: GET_ONE } = await import('../knowledge/[id]/route')
    const res = await PUT(json('PUT', `/api/knowledge/${captured.id}`, { content: 'tampered' }))
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, 'NOT_EDITABLE')
    // Nor readable whole through the repository route — retrieval context only.
    assert.equal((await GET_ONE(get(`/api/knowledge/${captured.id}`))).status, 404)
    const { buildWorkspaceFileTools } = await import('@/lib/knowledge/file-tools')
    const toolset = await buildWorkspaceFileTools({ organizationId, agentId, userId })
    const miss = (await toolset.execute.read_workspace_file({ file: 'Run summary' })) as { error?: string }
    assert.match(miss.error ?? '', /No workspace file matches/)
    const { GET } = await import('../knowledge/route')
    const list = await (await GET(get('/api/knowledge?source=repository'))).json()
    assert.equal(list.documents.some((d: any) => d.id === captured.id), false, 'not a repository file')
  })

  test('deleting the note removes it from the repository and the agent tools', async () => {
    const { DELETE } = await import('../knowledge/route')
    const res = await DELETE(json('DELETE', '/api/knowledge', { documentId: noteId }))
    assert.equal(res.status, 200)
    const { buildWorkspaceFileTools } = await import('@/lib/knowledge/file-tools')
    const toolset = await buildWorkspaceFileTools({ organizationId, agentId, userId })
    assert.equal(toolset.fileCount, 0)
    assert.deepEqual(toolset.tools, [])
  })
} else {
  test('knowledge files e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
