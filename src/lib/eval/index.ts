/**
 * Offline eval harness — public surface.
 *
 * Deterministic scripted replay (offline, CI-safe) + an LLM judge for live
 * quality checks. See types.ts for the fixture format.
 */
export * from './types'
export { ScriptedRunner } from './scripted-runner'
export { runLoop, replayScripted, scriptedDispatch, cannedDispatch, checkTrajectory, type ToolDispatch } from './harness'
export { judgeTrajectory } from './judge'
export { fixtureFromTranscript } from './from-transcript'
export { fixtures } from './fixtures'
