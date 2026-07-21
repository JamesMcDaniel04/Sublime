export type KnowledgeCaptureSettings = {
  captureEnabled: boolean
  captureAgentRuns: boolean
  captureFlowRuns: boolean
  captureConnectedData: boolean
  retainOnDisconnect: boolean
  zeroDataRetention: boolean
}

const DEFAULTS: KnowledgeCaptureSettings = {
  captureEnabled: true,
  captureAgentRuns: true,
  captureFlowRuns: true,
  captureConnectedData: true,
  retainOnDisconnect: true,
  zeroDataRetention: false,
}

/**
 * Knowledge capture is default-on: retained business context is a core
 * product capability, not an optional analytics add-on. Enterprise
 * zero-retention is an explicit fail-closed override.
 */
export function knowledgeCaptureSettings(value: unknown): KnowledgeCaptureSettings {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    captureEnabled: typeof settings.knowledgeCaptureEnabled === 'boolean' ? settings.knowledgeCaptureEnabled : DEFAULTS.captureEnabled,
    captureAgentRuns: typeof settings.captureAgentRunKnowledge === 'boolean' ? settings.captureAgentRunKnowledge : DEFAULTS.captureAgentRuns,
    captureFlowRuns: typeof settings.captureFlowRunKnowledge === 'boolean' ? settings.captureFlowRunKnowledge : DEFAULTS.captureFlowRuns,
    captureConnectedData: typeof settings.captureConnectedKnowledge === 'boolean' ? settings.captureConnectedKnowledge : DEFAULTS.captureConnectedData,
    retainOnDisconnect: typeof settings.retainKnowledgeOnDisconnect === 'boolean' ? settings.retainKnowledgeOnDisconnect : DEFAULTS.retainOnDisconnect,
    zeroDataRetention: settings.zeroDataRetention === true,
  }
}

export type KnowledgeSourceType = 'upload' | 'agent_run' | 'flow_run' | 'connection_profile' | 'activity_sync' | 'meeting_note' | 'manual'

export function shouldCaptureKnowledge(settings: KnowledgeCaptureSettings, sourceType: KnowledgeSourceType): boolean {
  if (!settings.captureEnabled || settings.zeroDataRetention) return false
  if (sourceType === 'agent_run') return settings.captureAgentRuns
  if (sourceType === 'flow_run') return settings.captureFlowRuns
  if (sourceType === 'connection_profile' || sourceType === 'activity_sync' || sourceType === 'meeting_note') return settings.captureConnectedData
  return true
}
