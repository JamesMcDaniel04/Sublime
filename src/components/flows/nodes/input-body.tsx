'use client'

import type { NodeBodyModule } from './types'

// input/output nodes have no builder palette entry yet (see node-types.ts) —
// this static copy is the whole authoring surface until that follow-up lands.
function InputBody() {
  return <p className="text-sm text-muted-foreground">Define the typed values callers may pass to this workflow.</p>
}

export const inputModule: NodeBodyModule = {
  Body: InputBody,
  requiredFields: [],
}
