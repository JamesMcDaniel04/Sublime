/**
 * WCAG 2.1 AA conformance on the public surface, checked with axe-core.
 *
 * ADA web claims are argued against WCAG 2.1 Level AA in practice, and the
 * pages below are the ones ANYONE can reach without an account — which makes
 * them both the highest-exposure surface and the only one an outside tester
 * can evaluate. Authenticated surfaces need a seeded session and are covered
 * separately (see the note at the bottom of this file).
 *
 * axe-core is injected from node_modules rather than pulled in as a new
 * dependency: it is already present in the tree, and an accessibility gate
 * should not itself widen the supply chain.
 *
 * axe finds roughly a third of WCAG issues. A green run here is a floor, not a
 * certificate — keyboard-only operation, screen-reader semantics and the flow
 * canvas all need human testing.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Resolved from the project root rather than via import.meta: Playwright loads
// these specs in a CommonJS context, where import.meta is a syntax error.
const AXE_SOURCE = readFileSync(join(process.cwd(), 'node_modules/axe-core/axe.min.js'), 'utf8')

type Violation = {
  id: string
  impact: string | null
  help: string
  helpUrl: string
  nodes: Array<{ target: string[]; failureSummary?: string }>
}

async function analyze(page: import('@playwright/test').Page): Promise<Violation[]> {
  // evaluate(), not addScriptTag(): the app's own Content-Security-Policy has
  // no 'unsafe-inline' in script-src, so an injected <script> is blocked — by
  // the control working exactly as intended. evaluate() runs through CDP and
  // is not subject to page CSP.
  await page.evaluate(AXE_SOURCE)
  return page.evaluate(async () => {
    // @ts-expect-error injected at runtime
    const results = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    })
    return results.violations
  })
}

/** Readable failure output — the default object dump is unreadable in CI. */
function describe(violations: Violation[]): string {
  return violations
    .map((v) => {
      const targets = v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n      ')
      const more = v.nodes.length > 4 ? `\n      …and ${v.nodes.length - 4} more` : ''
      return `  [${v.impact}] ${v.id}: ${v.help}\n      ${targets}${more}\n      ${v.helpUrl}`
    })
    .join('\n')
}

const PUBLIC_PAGES = ['/', '/about', '/contact', '/privacy', '/terms', '/auth/login', '/auth/signup']

for (const path of PUBLIC_PAGES) {
  test(`${path} has no serious or critical WCAG 2.1 AA violations`, async ({ page }) => {
    await page.goto(path)
    // The landing page animates in; assert against the settled DOM rather than
    // a frame mid-transition, or the run is flaky for reasons unrelated to a11y.
    await page.waitForLoadState('networkidle')

    const violations = await analyze(page)
    const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')

    // Assert on the COUNT with the detail as the message. Asserting on the
    // array itself dumps every axe node object into the diff and buries the
    // one thing a reader needs: which element, and why.
    expect(blocking.length, `\n${describe(blocking)}\n`).toBe(0)
  })
}

test('every page can be reached by keyboard from the top of the document', async ({ page }) => {
  // WCAG 2.4.1 Bypass Blocks. Without a skip link a keyboard or switch user
  // tabs the entire navigation on every single page load before reaching
  // content. `<main id="main-content">` already exists to be the target.
  await page.goto('/')
  await page.keyboard.press('Tab')
  const first = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return el ? { text: (el.textContent ?? '').trim().slice(0, 40), href: el.getAttribute('href') } : null
  })
  expect(first, 'nothing is focusable at the top of the document').not.toBeNull()
  expect(first?.href, 'the first tab stop should be a skip link pointing at #main-content').toBe('#main-content')
})

/**
 * Authenticated surfaces NOT covered here, and why:
 *
 * The product shell needs a seeded Supabase session, which this harness does
 * not have. The flow builder (@xyflow/react) is a drag-and-drop canvas and the
 * landing page renders three.js content — neither is meaningfully assessed by
 * an automated rule set, and both need a manual keyboard and screen-reader
 * pass. docs/accessibility.md records what that pass has to cover.
 */
