import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeGoogleSheetsMetricSource, parseSheetNumber } from '../sources/google-sheets'
import type { NangoProxy } from '@/lib/nango/delivery'

test('parseSheetNumber strips currency/commas, first numeric wins, null when none', () => {
  assert.equal(parseSheetNumber([['$41,203.50']]), 41203.5)
  assert.equal(parseSheetNumber([['n/a', '17']]), 17)
  assert.equal(parseSheetNumber([[]]), null)
  assert.equal(parseSheetNumber([['total', 'n/a']]), null)
  assert.equal(parseSheetNumber([[1234]]), 1234)
})

test('fetchValue reads config.spreadsheetId/range through the proxy', async () => {
  let endpoint = ''
  const proxy: NangoProxy = async (args) => {
    endpoint = args.endpoint
    return { data: { values: [['$500']] } }
  }
  const source = makeGoogleSheetsMetricSource(proxy)
  const reading = await source.fetchValue(
    {
      organizationId: 'org-1',
      connectionRef: 'google:gc-1',
      config: { spreadsheetId: 'sheet-1', range: 'KPIs!B2' },
    },
    'sheets.range',
  )
  assert.equal(reading.value, 500)
  assert.match(endpoint, /sheet-1/)
  assert.match(endpoint, /KPIs/)
})
