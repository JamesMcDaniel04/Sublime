import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertKindAllowed, validateComposition } from '../composition/presets'

test('an allowed kind passes', () => {
  assert.equal(assertKindAllowed('arr', ['arr', 'quota', 'kpi']), null)
})

test('a disallowed kind returns a message naming what is available', () => {
  const message = assertKindAllowed('quota', ['arr'])
  assert.ok(message)
  assert.ok(message.includes('quota'))
  assert.ok(message.includes('arr'))
})

test('a null composition is always valid — composition is opt-in', () => {
  assert.equal(validateComposition('arr', null, []), null)
  assert.equal(validateComposition('arr', undefined, []), null)
})

test('an ARR composition requires all four movement slots', () => {
  const message = validateComposition('arr', { kind: 'arr' }, ['new_arr'])
  assert.ok(message)
  assert.ok(message.includes('churned_arr'))
})

test('an ARR composition with all four slots is valid', () => {
  assert.equal(
    validateComposition('arr', { kind: 'arr' }, [
      'new_arr',
      'expansion_arr',
      'contraction_arr',
      'churned_arr',
    ]),
    null,
  )
})

test('ARR accepts its optional customer-count slots', () => {
  assert.equal(
    validateComposition('arr', { kind: 'arr' }, [
      'new_arr',
      'expansion_arr',
      'contraction_arr',
      'churned_arr',
      'customers_start',
      'customers_churned',
    ]),
    null,
  )
})

test('the composition kind must match the goal kind', () => {
  const message = validateComposition('arr', { kind: 'quota' }, [])
  assert.ok(message)
  assert.ok(message.includes('match'))
})

test('a malformed composition is rejected with a message, not silently dropped', () => {
  assert.ok(validateComposition('kpi', { kind: 'kpi' }, [])) // shape required
  assert.ok(validateComposition('arr', { nonsense: true }, []))
  assert.ok(validateComposition('arr', 'not an object', []))
})

test('a KPI ratio composition requires numerator and denominator', () => {
  assert.ok(validateComposition('kpi', { kind: 'kpi', shape: 'ratio' }, ['numerator']))
  assert.equal(
    validateComposition('kpi', { kind: 'kpi', shape: 'ratio' }, [
      'numerator',
      'denominator',
    ]),
    null,
  )
})

test('a KPI funnel requires one slot per declared stage', () => {
  assert.ok(
    validateComposition('kpi', { kind: 'kpi', shape: 'funnel', stages: 3 }, [
      'stage:1',
      'stage:2',
    ]),
  )
  assert.equal(
    validateComposition('kpi', { kind: 'kpi', shape: 'funnel', stages: 3 }, [
      'stage:1',
      'stage:2',
      'stage:3',
    ]),
    null,
  )
})

test('a quota composition needs no component slots', () => {
  assert.equal(validateComposition('quota', { kind: 'quota' }, []), null)
})

test('quota accepts its leading-indicator slots', () => {
  assert.equal(
    validateComposition('quota', { kind: 'quota' }, ['pipeline_coverage', 'win_rate']),
    null,
  )
})

test('unknown slots are rejected so a typo is not silently inert', () => {
  const message = validateComposition('arr', { kind: 'arr' }, [
    'new_arr',
    'expansion_arr',
    'contraction_arr',
    'churned_arr',
    'nwe_arr',
  ])
  assert.ok(message)
  assert.ok(message.includes('nwe_arr'))
})

test('a duplicated slot is rejected', () => {
  const message = validateComposition('arr', { kind: 'arr' }, [
    'new_arr',
    'new_arr',
    'expansion_arr',
    'contraction_arr',
    'churned_arr',
  ])
  assert.ok(message)
  assert.ok(message.includes('new_arr'))
})
