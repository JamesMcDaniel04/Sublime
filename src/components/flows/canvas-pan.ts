/**
 * Click-and-hold panning for the flow-builder canvas. The canvas is a
 * vertically scrolling column (no XY plane), so "pan" maps drag-Y onto the
 * scroll container's scrollTop. Pure DOM logic — the builder page wires
 * pointer events to a session; tests drive it directly.
 */

/** Surfaces a pan must never start from: step cards + form/menu interactions. */
export const PAN_INTERACTIVE_SELECTOR =
  '[data-node-id], button, a, input, textarea, select, [role="menu"], [role="dialog"]'

/** Movement below this is a click (deselect etc.), not a drag. */
const DRAG_THRESHOLD_PX = 3

export type CanvasPanSession = {
  /** Feed pointermove clientY; scrolls once the threshold is crossed. */
  move(clientY: number): void
  /** Finish the gesture; `dragged` tells the caller to suppress the click. */
  end(): { dragged: boolean }
}

/**
 * Start a pan session for a pointerdown, or null when the gesture belongs to
 * something else (non-left button, or a press on an interactive element).
 */
export function startCanvasPan(
  container: HTMLElement,
  event: { button: number; clientY: number; target: EventTarget | null },
): CanvasPanSession | null {
  if (event.button !== 0) return null
  // Duck-typed (not `instanceof Element`): the global Element constructor is
  // absent outside the browser (SSR / node test runner).
  const target = event.target as { closest?: (selector: string) => unknown } | null
  if (target && typeof target.closest === 'function' && target.closest(PAN_INTERACTIVE_SELECTOR)) return null

  const startY = event.clientY
  const startScrollTop = container.scrollTop
  let dragged = false

  return {
    move(clientY: number) {
      const delta = startY - clientY
      if (!dragged && Math.abs(delta) < DRAG_THRESHOLD_PX) return
      dragged = true
      container.scrollTop = startScrollTop + delta
    },
    end: () => ({ dragged }),
  }
}
