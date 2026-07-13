export type FlowFailureRemediationKind = 'safe_fix' | 'retry_tuning' | 'user_action' | 'diagnose'

export type FlowFailureRemediation = {
  kind: FlowFailureRemediationKind
  nodeId?: string
  error: string
  title: string
  summary: string
  actionLabel: string
  userSteps: string[]
  copilotPrompt: string
}

type FailedRunLike = {
  status?: string
  error?: string | null
  steps?: Array<{ nodeId?: string; status?: string; error?: string | null }>
}

function failureOf(run: FailedRunLike): { error: string; nodeId?: string } | null {
  if (run.status !== 'failed') return null
  const step = [...(run.steps ?? [])].reverse().find((candidate) => candidate.status === 'failed' || candidate.error)
  const error = String(step?.error || run.error || 'The flow failed without a recorded error.').trim().slice(0, 1_200)
  return { error, nodeId: step?.nodeId }
}

/**
 * Classify a runtime failure before involving AI. The result deliberately
 * separates graph-editable failures from credentials, permissions, and
 * missing business values that Copilot must never invent.
 */
export function remediationForFailedRun(run: FailedRunLike | null | undefined): FlowFailureRemediation | null {
  if (!run) return null
  const failure = failureOf(run)
  if (!failure) return null
  const { error, nodeId } = failure
  const lower = error.toLowerCase()
  const target = nodeId ? `the failing node ${nodeId}` : 'the failing flow'

  if (/could not resolve url host|invalid url|url host|enotfound|dns/.test(lower)) {
    return {
      kind: 'user_action', nodeId, error,
      title: 'A valid destination is required',
      summary: 'Copilot cannot safely invent the service or hostname this step should call.',
      actionLabel: 'Ask Copilot for setup steps',
      userSteps: [
        'Open the failing step and enter a complete HTTPS URL with a real hostname.',
        'If this should use a connected app, replace the raw HTTP step with that integration action.',
        'Save, then run the flow again.',
      ],
      copilotPrompt: `This run failed at ${target} with: ${error}. Do not change the graph or invent a URL. Explain exactly where the user should supply a valid HTTPS endpoint or choose a connected integration action, then tell them how to retry.`,
    }
  }

  if (/unauthori[sz]ed|forbidden|credential|authentication|access token|api key|not connected|reconnect|permission|missing scope|insufficient_scope|invalid_auth|token_expired/.test(lower)) {
    return {
      kind: 'user_action', nodeId, error,
      title: 'The connected account needs attention',
      summary: 'Credentials, permissions, and workspace access require the user; Copilot will not fabricate or replace them.',
      actionLabel: 'Show reconnection steps',
      userSteps: [
        'Open Integrations and reconnect the account used by the failing step.',
        'Approve the requested permissions or scopes in the external service.',
        'Return to this flow, confirm the correct connection, and run it again.',
      ],
      copilotPrompt: `This run failed at ${target} with: ${error}. Do not edit the graph. Give concise, concrete steps to reconnect the relevant account, verify permissions, return to this node, and rerun safely.`,
    }
  }

  if (/missing|required|must provide|cannot be empty|no value|not found|404/.test(lower)) {
    return {
      kind: 'user_action', nodeId, error,
      title: 'This run needs a value or record from you',
      summary: 'The missing input cannot be inferred reliably from the failed run.',
      actionLabel: 'Ask Copilot what is missing',
      userSteps: [
        'Inspect the failing step input and identify the empty field or missing record ID.',
        'Map it from an earlier step or provide it in the run input.',
        'Confirm the referenced external record still exists, then retry.',
      ],
      copilotPrompt: `This run failed at ${target} with: ${error}. Do not invent missing values or IDs. Inspect the graph and explain which user-supplied field, mapping, or external record is required and where to provide it.`,
    }
  }

  if (/rate limit|too many requests|\b429\b|timed? out|timeout|temporar|\b5\d\d\b|network|fetch failed|socket/.test(lower)) {
    return {
      kind: 'retry_tuning', nodeId, error,
      title: 'Checker can harden this transient failure',
      summary: 'The destination was temporarily unavailable or throttled. A bounded retry/timeout adjustment may make the step resilient.',
      actionLabel: 'Let Copilot add resilience',
      userSteps: [],
      copilotPrompt: `Fix the runtime failure at ${target}: ${error}. Make only a minimal reliability edit to that node, using bounded retries and a reasonable timeout supported by its node type. Do not change business logic, credentials, URLs, or unrelated nodes. If no safe graph edit exists, make no change and explain why.`,
    }
  }

  if (/invalid json|json parse|parse json|expected (an )?object|schema|invalid argument|malformed|unsupported method|template expression|could not parse/.test(lower)) {
    return {
      kind: 'safe_fix', nodeId, error,
      title: 'Checker found a graph-editable failure',
      summary: 'The failing step has a malformed mapping, payload, or configuration that Copilot can repair without external credentials.',
      actionLabel: 'Let Copilot fix the step',
      userSteps: [],
      copilotPrompt: `Fix the runtime failure at ${target}: ${error}. Inspect the current graph and make the smallest safe edit to the failing node's mapping, payload, or configuration. Preserve business logic and all valid values. Never invent credentials, external IDs, or endpoints.`,
    }
  }

  return {
    kind: 'diagnose', nodeId, error,
    title: 'Copilot can diagnose this failure',
    summary: 'The error is not specific enough for Checker to apply a deterministic fix safely.',
    actionLabel: 'Ask Copilot to diagnose',
    userSteps: [],
    copilotPrompt: `Diagnose the runtime failure at ${target}: ${error}. Inspect the graph. If a minimal safe graph fix is clear, apply only that fix. If the fix needs a credential, endpoint, business value, permission, or user decision, make no changes and give exact user steps instead.`,
  }
}
