import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMcpText, enrichAccount, enrichOpportunity, type SalesAiCaller } from '../salesai-facts'

test('extractMcpText joins text content blocks; tolerates strings and junk', () => {
  assert.equal(extractMcpText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(extractMcpText('plain'), 'plain')
  assert.equal(extractMcpText({ content: [{ type: 'image' }] }), '')
  assert.equal(extractMcpText(null), '')
})

function caller(handler: (name: string, args: Record<string, unknown>) => unknown): SalesAiCaller & { calls: Array<{ name: string; args: any }> } {
  const calls: Array<{ name: string; args: any }> = []
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args })
      return handler(name, args)
    },
  }
}

test('enrichAccount: numeric id calls get_account_status directly', async () => {
  const c = caller((name) => name === 'get_account_status' ? { content: [{ type: 'text', text: 'Falken Group — high churn risk; champion left.' }] } : {})
  const result = await enrichAccount(c, '4021')
  assert.equal(result?.peopleaiId, 4021)
  assert.match(result!.text, /high churn risk/)
  assert.deepEqual(c.calls.map((x) => x.name), ['get_account_status'])
  assert.equal(c.calls[0].args.peopleai_account_id, 4021)
})

test('enrichAccount: CRM id is resolved via find_record_by_crm_id first', async () => {
  const c = caller((name) => {
    if (name === 'find_record_by_crm_id') return { content: [{ type: 'text', text: '{"peopleai_account_id": 900}' }] }
    if (name === 'get_account_status') return { content: [{ type: 'text', text: 'status for 900' }] }
    return {}
  })
  const result = await enrichAccount(c, '0015000000ABCDE')
  assert.equal(result?.peopleaiId, 900)
  assert.deepEqual(c.calls.map((x) => x.name), ['find_record_by_crm_id', 'get_account_status'])
})

test('enrichAccount: returns null (not throw) when the tool errors', async () => {
  const c = caller(() => { throw new Error('mcp down') })
  assert.equal(await enrichAccount(c, '4021'), null)
})

test('enrichOpportunity: numeric id → get_opportunity_status', async () => {
  const c = caller((name) => name === 'get_opportunity_status' ? { content: [{ type: 'text', text: 'renewal at risk' }] } : {})
  const result = await enrichOpportunity(c, 55)
  assert.equal(result?.peopleaiId, 55)
  assert.match(result!.text, /renewal at risk/)
  assert.equal(c.calls[0].args.peopleai_opportunity_id, 55)
})

test('enrichOpportunity: non-numeric ref returns null without any call', async () => {
  const c = caller(() => ({}))
  assert.equal(await enrichOpportunity(c, 'not-an-id'), null)
  assert.equal(c.calls.length, 0)
})
