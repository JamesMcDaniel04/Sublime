/**
 * Minimal jsdom environment for React component tests run under `tsx --test`.
 * Import this FIRST (before react-dom) so the DOM globals exist at module load.
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const win = dom.window as unknown as Record<string, unknown>
const g = globalThis as unknown as Record<string, unknown>

// Copy DOM constructors/globals React and Testing Library expect. Some globals
// (navigator) are read-only on Node 22 — define them non-fatally.
const keys = ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'KeyboardEvent', 'InputEvent', 'MouseEvent', 'getComputedStyle', 'DocumentFragment', 'Range', 'Text', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver']
g.window = dom.window
// Browser code (e.g. next/link's viewport-prefetch, which reads
// `self.requestIdleCallback`) assumes `self` exists as an alias for
// `window`. jsdom doesn't set a global `self`, so leaving it undefined
// throws a ReferenceError the first time such code runs.
g.self = dom.window
for (const key of keys) {
  if (key === 'window') continue
  try { g[key] = win[key] } catch { /* read-only global, skip */ }
}
try {
  Object.defineProperty(g, 'navigator', { value: win.navigator, configurable: true })
} catch { /* leave Node's navigator */ }
// React 18 act() environment flag.
g.IS_REACT_ACT_ENVIRONMENT = true
