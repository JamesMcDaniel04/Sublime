import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { prepareToolArgs } from '@/features/flows/tool-args'
import { flowToolOutput } from '@/features/flows/tool-output'
import { pollItemsFrom } from '@/lib/flows/poll-trigger'
import { pickerPlaneAllowed, PICKER_ITEM_CAP } from '@/lib/flows/tool-options'

export const runtime = 'nodejs'

const schema = z.object({
  connectionId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  itemsPath: z.string().optional(),
})

/**
 * Run a READ tool and return its items, so a step's config can offer a real
 * dropdown — pick a channel / board / record from the connection instead of
 * pasting an opaque id.
 *
 * TWO independent refusals stand between this and a side effect, and both are
 * load-bearing:
 *
 *  1. The plane allowlist (lib/flows/tool-options.ts). Only planes whose
 *     `isWrite` is authoritative PER TOOL get here at all. This is not
 *     belt-and-braces: the `flow` plane reports isWrite:false while executing
 *     an entire flow, so check 2 alone would admit it.
 *  2. The executor's own `isWrite`, for planes where that flag is trustworthy.
 *
 * Items come from pollItemsFrom — the same extraction the polling trigger
 * already uses (explicit path › array › common list keys), so a picker and a
 * poll read the same tool result the same way rather than drifting apart.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = schema.parse(await request.json())
  const { plane, ref } = parseFlowToolConnectionId(body.connectionId)

  const decision = pickerPlaneAllowed(plane)
  if (!decision.allowed) return { success: false as const, error: decision.reason }

  const executor = await resolveFlowToolExecutor({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    plane,
    ref,
    toolName: body.toolName,
  })
  if (executor.isWrite) {
    return { success: false as const, error: 'Only read actions can populate a picker.' }
  }

  const result = flowToolOutput(await executor.execute(body.toolName, prepareToolArgs(body.args ?? {})))
  // Capped: a workspace with 10k Slack channels must not return 10k rows to a
  // dropdown, and the response is rendered into the builder synchronously.
  return { success: true as const, items: pollItemsFrom(result, body.itemsPath).slice(0, PICKER_ITEM_CAP) }
}, { requires: 'member' })
