import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from '@/generated/prisma/client'
import { capabilitiesForPlan } from '../capabilities'

test('Individual has one core area and private skills', () => {
  const capability = capabilitiesForPlan(Plan.STARTER)
  assert.equal(capability.specialistAreas, 'one')
  assert.equal(capability.skillSharing, 'private')
  assert.equal(capability.unlimitedKnowledge, true)
  assert.equal(capability.unlimitedConnectedTools, true)
})

test('Team and Business include every core area and priority support routing', () => {
  for (const plan of [Plan.PROFESSIONAL, Plan.BUSINESS]) {
    const capability = capabilitiesForPlan(plan)
    assert.equal(capability.specialistAreas, 'every')
    assert.equal(capability.skillSharing, 'controlled')
    assert.equal(capability.support, 'priority')
  }
})

test('Enterprise unlocks custom scopes, dedicated routing, and zero retention', () => {
  const capability = capabilitiesForPlan(Plan.ENTERPRISE)
  assert.equal(capability.specialistAreas, 'custom')
  assert.equal(capability.support, 'dedicated')
  assert.equal(capability.zeroDataRetention, true)
})
