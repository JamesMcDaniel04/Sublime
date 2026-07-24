'use client'

import type { NodeBodyModule } from './types'

// See input-body.tsx — same deferred-palette situation.
function OutputBody() {
  return <p className="text-sm text-muted-foreground">Define the values this workflow returns to callers.</p>
}

export const outputModule: NodeBodyModule = {
  Body: OutputBody,
  requiredFields: [],
}
