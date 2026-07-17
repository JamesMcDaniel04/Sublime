import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let seeded: any

  before(async () => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const postFile = async (name: string, type: string, content: string | Buffer) => {
    const { POST } = await import('../extract/route')
    const form = new FormData()
    form.set('file', new File([content], name, { type }))
    return POST(new NextRequest(new URL('http://test/api/assistant/extract'), { method: 'POST', body: form }))
  }

  test('extracts text from a markdown file', async () => {
    const res = await postFile('assignment.md', 'text/markdown', '# Assignment\nSummarize weekly sales.')
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.filename, 'assignment.md')
    assert.match(data.text, /Summarize weekly sales/)
    assert.equal(data.truncated, false)
  })

  test('rejects unsupported types with 415', async () => {
    const res = await postFile('photo.png', 'image/png', Buffer.from([0x89, 0x50]))
    assert.equal(res.status, 415)
  })

  test('truncates long text and flags it', async () => {
    const res = await postFile('big.txt', 'text/plain', 'a'.repeat(30_000))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.text.length, 24_000)
    assert.equal(data.truncated, true)
  })

  test('rejects a missing file with 400', async () => {
    const { POST } = await import('../extract/route')
    const form = new FormData()
    const res = await POST(new NextRequest(new URL('http://test/api/assistant/extract'), { method: 'POST', body: form }))
    assert.equal(res.status, 400)
  })
} else {
  test('extract tests need TEST_DATABASE_URL', { skip: true }, () => {})
}
