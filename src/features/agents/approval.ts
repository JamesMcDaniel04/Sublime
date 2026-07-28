/**
 * Human approval gate for consequential (write-plane) tool calls.
 *
 * When an agent's metadata sets `requireApproval: true`, every write-plane
 * tool call (Slack/Email/HTTP builtins, all nango:* delivery planes — derived
 * from the connector registry, never a local regex) suspends the run as
 * `waiting_for_input` instead of executing. The user's reply resolves it:
 * an explicit affirmative executes the held call, anything else denies it
 * (deny-by-default). Approvals are NEVER auto-answered from memory — that
 * path only applies to ask_user questions.
 */
import type { ToolResult } from '@/lib/llm/model-runner'
import { alwaysRequiresApproval, isWriteProvider } from '@/lib/connectors/registry'

/** A write tool call held for approval; persisted on execution metadata. */
export type PendingApproval = {
  toolCallId: string
  /** Model-facing tool name — the bindings-map key looked up on resume. */
  toolName: string
  /** `provider.toolName`, for display and the workflow step node. */
  node: string
  input: Record<string, unknown>
  stepId: string | null
  collectedResults: ToolResult[]
}

// Deny-by-default: only a standalone, unambiguous affirmative approves. A
// qualified reply ("yes but change the subject") is a denial the model can
// read and act on — the denial result carries the user's words.
const APPROVE_RE = /^(approve|approved|yes|y|yep|ok|okay|confirm|confirmed|proceed|go ahead|lgtm|do it|send it)[.!]*$/i

export function isApprovalReply(reply: string | null | undefined): boolean {
  if (!reply) return false
  return APPROVE_RE.test(reply.trim())
}

/**
 * True when this call must pause for a human.
 *
 * Two independent paths reach a pause:
 *   - the plane requires approval unconditionally (Postgres writes — a
 *     model-authored statement against a customer database), or
 *   - the agent opted in AND the plane writes (every other write plane).
 *
 * Both derive from the connector registry rather than a local regex, so a new
 * plane cannot drift out of the gate.
 */
export function toolNeedsApproval(params: { requireApproval: boolean; provider: string | null | undefined }): boolean {
  if (!params.provider) return false
  if (alwaysRequiresApproval(params.provider)) return true
  if (!params.requireApproval) return false
  return isWriteProvider(params.provider)
}

const APPROVAL_INPUT_PREVIEW_CHARS = 600

/** The question shown to the user while a write call is held. */
export function approvalQuestion(node: string, input: unknown): string {
  let preview: string
  try {
    preview = JSON.stringify(input ?? {})
  } catch {
    preview = String(input)
  }
  if (preview.length > APPROVAL_INPUT_PREVIEW_CHARS) {
    preview = `${preview.slice(0, APPROVAL_INPUT_PREVIEW_CHARS)}… (truncated)`
  }
  return `Approval required: run ${node} with ${preview}? Reply "approve" to run it — anything else denies it.`
}
