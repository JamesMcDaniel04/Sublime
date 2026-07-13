import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate } from '@/components/ui/pagination'

test('template-sized pages show 9 cards and preserve the remainder', () => {
  const items = Array.from({ length: 20 }, (_, index) => index + 1)
  assert.deepEqual(paginate(items, 1, 9).pageItems, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(paginate(items, 2, 9).pageItems, [10, 11, 12, 13, 14, 15, 16, 17, 18])
  assert.deepEqual(paginate(items, 3, 9).pageItems, [19, 20])
  assert.equal(paginate(items, 1, 9).pageCount, 3)
})
