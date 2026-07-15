/**
 * A minimal layout engine for jsdom, so React Flow can be tested for real.
 *
 * jsdom implements the DOM but NOT layout: every element measures 0×0, no
 * ResizeObserver ever fires, and there is no DOMMatrix. React Flow refuses to
 * paint an edge between nodes it hasn't measured, so without these shims a
 * canvas test can only ever assert that nodes mount — never that wires render.
 *
 * These are the shims React Flow documents for jsdom, with two fixes:
 *   - their published scale regex `scale\(([1-9.])\)` matches a SINGLE char, so
 *     it misreads any zoom of 2+ digits (e.g. `scale(1.25)`); this uses `+`.
 *   - unstyled elements fall back to a realistic card footprint rather than 1px,
 *     so edge geometry resembles a real browser instead of collapsing to a point.
 *
 * Import AFTER the jsdom env (`@/test-support/jsdom-env`). Node's test runner
 * gives each test FILE its own process, so patching prototypes here cannot leak
 * into other component tests.
 */
import { NODE_HEIGHT, NODE_WIDTH } from '@/lib/flows/auto-layout'

/** The box an element reports. Honours an inline size; falls back to a card. */
function boxOf(element: Element): { width: number; height: number } {
  const style = (element as HTMLElement).style
  return {
    width: Number.parseFloat(style?.width) || NODE_WIDTH,
    height: Number.parseFloat(style?.height) || NODE_HEIGHT,
  }
}

class LayoutResizeObserver {
  private readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe(target: Element) {
    // Async, like the real observer — React Flow expects measurement to arrive
    // after mount, not synchronously during it. The entry MUST carry contentRect:
    // React Flow reads `entry.contentRect.width`, so a bare { target } throws.
    setTimeout(() => {
      const { width, height } = boxOf(target)
      const entry = { target, contentRect: { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height } }
      this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
    }, 0)
  }
  unobserve() {
    /* nothing to release — this observer holds no state */
  }
  disconnect() {
    /* nothing to release — this observer holds no state */
  }
}

class LayoutDOMMatrixReadOnly {
  readonly m22: number
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1]
    this.m22 = scale === undefined ? 1 : Number(scale)
  }
}

let installed = false

/** Give jsdom just enough layout for React Flow to measure and draw. */
export function installReactFlowLayout() {
  if (installed) return
  installed = true
  const scope = globalThis as unknown as Record<string, unknown>
  const win = scope.window as Record<string, unknown> | undefined
  scope.ResizeObserver = LayoutResizeObserver
  scope.DOMMatrixReadOnly = LayoutDOMMatrixReadOnly
  if (win) {
    win.ResizeObserver = LayoutResizeObserver
    win.DOMMatrixReadOnly = LayoutDOMMatrixReadOnly
  }

  // jsdom-env only copies a fixed list of constructors onto globalThis (SVGElement
  // is NOT among them), so resolve from the jsdom window first.
  const ctor = (name: string) => (win?.[name] ?? scope[name]) as { prototype: Record<string, unknown> } | undefined

  // Measurement: honour an inline size when present (our node cards set one),
  // otherwise report the standard card footprint so nodes are never 0×0.
  const htmlElement = ctor('HTMLElement')
  if (htmlElement) {
    Object.defineProperties(htmlElement.prototype, {
      offsetWidth: {
        configurable: true,
        get(this: HTMLElement) {
          return parseFloat(this.style.width) || NODE_WIDTH
        },
      },
      offsetHeight: {
        configurable: true,
        get(this: HTMLElement) {
          return parseFloat(this.style.height) || NODE_HEIGHT
        },
      },
    })
  }
  const svgElement = ctor('SVGElement')
  if (svgElement) svgElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 })

  // jsdom's getBoundingClientRect is hard-coded to all zeros. React Flow uses it
  // to place handles/edges, and a 0×0 node is treated as unmeasured (no wire is
  // drawn), so give it the same box the observer reports.
  const element = ctor('Element')
  if (element) {
    element.prototype.getBoundingClientRect = function (this: Element) {
      const { width, height } = boxOf(this)
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }
    }
  }
}
