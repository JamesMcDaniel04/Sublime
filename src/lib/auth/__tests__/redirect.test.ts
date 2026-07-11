import assert from 'node:assert/strict'
import test from 'node:test'
import { safeReturnToPath } from '../redirect'

test('safeReturnToPath preserves safe local paths', () => {
  assert.equal(safeReturnToPath('/flows/1?tab=activity'), '/flows/1?tab=activity')
})

test('safeReturnToPath rejects external and ambiguous paths', () => {
  assert.equal(safeReturnToPath('//evil.example'), '/dashboard')
  assert.equal(safeReturnToPath('/\\evil.example'), '/dashboard')
  assert.equal(safeReturnToPath('https://evil.example'), '/dashboard')
  assert.equal(safeReturnToPath('/hello world'), '/dashboard')
})
