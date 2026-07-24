import type { FlowNode } from '@/lib/flows/graph'
import type { NodeBodyModule } from './types'
import { respondWebhookModule } from './respond-webhook-body'
import { waitModule } from './wait-body'
import { subflowModule } from './subflow-body'
import { stopModule } from './stop-body'

/**
 * Every node type's authoring surface, keyed by type.
 *
 * Replaces the `renderNodeBody` switch that used to be the ONLY thing that knew
 * which fields a node type has. As data it can be consumed more than once — the
 * canvas card and the node detail view render the same body — and iterated, so a
 * totality test can prove no node type ships without a param surface.
 *
 * Widened to a total Record once every body has moved, at which point `tsc`
 * enforces exhaustiveness too.
 */
export const NODE_BODIES: Partial<Record<FlowNode['type'], NodeBodyModule>> = {
  respondWebhook: respondWebhookModule,
  wait: waitModule,
  subflow: subflowModule,
  stop: stopModule,
}
