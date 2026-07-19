import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip'

// Radix portals emit nothing during SSR, so TooltipContent's classes can't be
// asserted from renderToString — check the source directly instead.
test('TooltipContent uses theme tokens, not static graphite', () => {
  const src = readFileSync('src/components/ui/tooltip.tsx', 'utf8')
  assert.doesNotMatch(src, /bg-graphite-900/)
  assert.match(src, /bg-foreground/)
  assert.match(src, /text-background/)
})

test('Tooltip tree renders SSR-safe', () => {
  const html = renderToString(
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild><button>trigger</button></TooltipTrigger>
        <TooltipContent>hint</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  )
  assert.match(html, /trigger/)
})
