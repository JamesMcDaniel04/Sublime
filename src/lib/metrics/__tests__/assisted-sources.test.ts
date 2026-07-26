import assert from 'node:assert/strict'
import test from 'node:test'
import { extractMetricReading } from '../assisted-extraction'
import { makeSlackAssistedMetricSource } from '../sources/slack-assisted'
import { extractMessageText, makeGmailAssistedMetricSource } from '../sources/gmail-assisted'
import type { NangoProxy } from '@/lib/nango/delivery'

const generateReturning = (payload: unknown) =>
  (async () => JSON.stringify(payload)) as never

test('extraction: found=false and low confidence both refuse to produce a reading', async () => {
  const base = { goalName: 'MRR', sourceLabel: '#revenue', corpus: 'MRR was $50k last week' }
  await assert.rejects(
    extractMetricReading({ ...base, generate: generateReturning({ found: false, value: 0, confidence: 'high', evidence: '' }) }),
    /No confident reading/,
  )
  await assert.rejects(
    extractMetricReading({ ...base, generate: generateReturning({ found: true, value: 50_000, confidence: 'low', evidence: 'maybe' }) }),
    /No confident reading/,
  )
  const good = await extractMetricReading({
    ...base,
    generate: generateReturning({ found: true, value: 50_000, confidence: 'high', evidence: 'MRR was $50k' }),
  })
  assert.equal(good.value, 50_000)
  await assert.rejects(extractMetricReading({ ...base, corpus: '   ' }), /No recent content/)
})

test('slack assisted: resolves #name, reads history, extracts', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  const urls: string[] = []
  const source = makeSlackAssistedMetricSource({
    fetchImpl: (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(
        JSON.stringify({ ok: true, messages: [{ text: 'Weekly MRR: $52,000' }, { text: 'standup notes' }] }),
      )
    }) as typeof fetch,
    listChannels: async () => [{ id: 'C123456789', name: 'revenue', isPrivate: false, isMember: true }],
    generate: generateReturning({ found: true, value: 52_000, confidence: 'high', evidence: 'Weekly MRR: $52,000' }),
  })
  const reading = await source.fetchValue(
    { organizationId: 'org', connectionRef: null, config: { channel: '#revenue', metricHint: 'MRR' } },
    'assisted.value',
  )
  assert.equal(reading.value, 52_000)
  assert.match(urls[0], /conversations\.history/)
  assert.match(urls[0], /channel=C123456789/)
  delete process.env.SLACK_BOT_TOKEN
})

test('gmail assisted: searches, decodes bodies, extracts; empty search fails clearly', async () => {
  const proxy: NangoProxy = async (args) => {
    if (args.endpoint === '/gmail/v1/users/me/messages') {
      return { data: { messages: [{ id: 'm1' }] } }
    }
    return {
      data: {
        snippet: 'fallback',
        payload: {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: Buffer.from('Pipeline report: 87 SQLs this month').toString('base64') },
            },
          ],
        },
      },
    }
  }
  const source = makeGmailAssistedMetricSource({
    proxyFor: () => proxy,
    generate: generateReturning({ found: true, value: 87, confidence: 'medium', evidence: '87 SQLs' }),
  })
  const reading = await source.fetchValue(
    { organizationId: 'org', connectionRef: 'google:gc-1', config: { query: 'subject:pipeline report' } },
    'assisted.value',
  )
  assert.equal(reading.value, 87)

  const empty = makeGmailAssistedMetricSource({
    proxyFor: () => (async () => ({ data: { messages: [] } })) as never,
    generate: generateReturning({ found: true, value: 1, confidence: 'high', evidence: 'x' }),
  })
  await assert.rejects(
    empty.fetchValue(
      { organizationId: 'org', connectionRef: 'google:gc-1', config: { query: 'subject:none' } },
      'assisted.value',
    ),
    /No emails matched/,
  )
})

test('gmail body extraction prefers text parts and strips html', () => {
  const html = Buffer.from('<div><b>MRR</b> is $9,000</div>').toString('base64')
  assert.match(extractMessageText({ mimeType: 'text/html', body: { data: html } }), /MRR\s+is \$9,000/)
  assert.equal(extractMessageText(undefined), '')
})
