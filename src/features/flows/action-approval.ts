/**
 * Human approval gate for flow action steps (tool + http nodes).
 *
 * The agent runtime gates writes because the MODEL chooses the URL, headers,
 * and body — an un-gated POST there is an exfiltration primitive for injected
 * instructions. A flow action is different: its URL and body are author-written
 * templates, so gating every write unconditionally would pause every existing
 * flow at every POST. The control here is therefore an explicit per-node
 * opt-in (`requireApproval` on the node), which gives an author the same
 * hold-before-it-fires safety on the steps that actually warrant it — a
 * payout, a bulk delete, a customer-facing send.
 *
 * Mechanics reuse the run's existing pause machinery verbatim: the adapter
 * returns `waiting`, the interpreter parks the run, and the user's reply
 * resumes it. Approval is deny-by-default and shares the agent runtime's
 * affirmative matcher, so "yes but change the amount" denies rather than
 * fires — the denial text reaches the flow as the step error.
 */
import { isApprovalReply } from '@/features/agents/approval'

/** Characters of resolved config echoed back in the approval question. */
const APPROVAL_PREVIEW_CHARS = 600

/** Header names whose values must never appear in an approval prompt. */
const SENSITIVE_KEYS = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|token|secret|password)$/i

export type FlowActionKind = 'tool' | 'http'

/**
 * True when this step must pause for a human before it runs.
 *
 * Opt-in only: the node's own `requireApproval` flag. A node the author flagged
 * pauses whatever its method or plane — "hold this step" is what they asked
 * for, and second-guessing it by re-classifying the verb would make the
 * control unpredictable.
 */
export function flowActionNeedsApproval(config: Record<string, unknown>): boolean {
  return config.requireApproval === true
}

/** Redact credential-shaped values before the config is shown to a human. */
function safePreview(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safePreview)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        SENSITIVE_KEYS.test(key) ? '[redacted]' : safePreview(inner),
      ]),
    )
  }
  return value
}

/**
 * The question shown while an action step is held. Summarises what will run
 * with enough specificity to judge it — the target, and a redacted preview of
 * the resolved payload.
 */
export function flowActionApprovalQuestion(params: {
  kind: FlowActionKind
  label?: string
  config: Record<string, unknown>
}): string {
  const { kind, config } = params
  const name = params.label?.trim() || (kind === 'http' ? 'HTTP request' : 'Tool call')
  const target =
    kind === 'http'
      ? `${String(config.method ?? 'POST').toUpperCase()} ${String(config.url ?? '')}`
      : String(config.toolName ?? 'tool')

  let preview: string
  try {
    const subject = kind === 'http' ? { headers: config.headers, body: config.body } : config.args
    preview = JSON.stringify(safePreview(subject) ?? {})
  } catch {
    preview = '(payload could not be previewed)'
  }
  if (preview.length > APPROVAL_PREVIEW_CHARS) {
    preview = `${preview.slice(0, APPROVAL_PREVIEW_CHARS)}… (truncated)`
  }

  return `Approval required — "${name}" will run ${target} with ${preview}. Reply "approve" to run it; anything else cancels this step.`
}

export type ApprovalDecision =
  | { approved: true }
  | { approved: false; error: string }

/**
 * Resolve a held step against the reply that resumed the run. Deny-by-default:
 * a missing, empty, or qualified reply cancels the step and surfaces the user's
 * own words as the step error, so the flow's onError branch can act on them.
 */
export function resolveFlowActionApproval(reply: string | null | undefined): ApprovalDecision {
  if (isApprovalReply(reply)) return { approved: true }
  const said = reply?.trim()
  return {
    approved: false,
    error: said
      ? `Step cancelled — approval was not granted (reply: "${said.slice(0, 200)}").`
      : 'Step cancelled — approval was not granted.',
  }
}
