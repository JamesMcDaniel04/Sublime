/**
 * Click-and-hold panning for the flow-builder canvas. A drag session reports
 * cumulative 2D deltas from the pointer-down origin; the builder applies them
 * as a CSS translate on the canvas plane (alongside the zoom scale), so the
 * plane follows the hand even when the content doesn't overflow — grabbing
 * empty background always moves the canvas, Power-Automate style. Pure logic:
 * the page component wires pointer events; tests drive this directly.
 */

/** Surfaces a pan must never start from: step cards + form/menu interactions. */
export const PAN_INTERACTIVE_SELECTOR =
  '[data-node-id], button, a, input, textarea, select, [role="menu"], [role="dialog"]'

/** Movement below this is a click (deselect etc.), not a drag. */
const DRAG_THRESHOLD_PX = 3

export type CanvasPanSession = {
  /** Feed pointermove coordinates; applies deltas once the threshold is crossed. */
  move(clientX: number, clientY: number): void
  /** Finish the gesture; `dragged` tells the caller to suppress the click. */
  end(): { dragged: boolean }
}

/**
 * Start a pan session for a pointerdown, or null when the gesture belongs to
 * something else (non-left button, or a press on an interactive element).
 * `apply` receives the CUMULATIVE delta from the pointer-down origin — the
 * caller adds it to the pan offset captured at drag start.
 */
export function startCanvasPan(
  event: { button: number; clientX: number; clientY: number; target: EventTarget | null },
  apply: (dx: number, dy: number) => void,
): CanvasPanSession | null {
  if (event.button !== 0) return null
  // Duck-typed (not `instanceof Element`): the global Element constructor is
  // absent outside the browser (SSR / node test runner).
  const target = event.target as { closest?: (selector: string) => unknown } | null
  if (target && typeof target.closest === 'function' && target.closest(PAN_INTERACTIVE_SELECTOR)) return null

  const startX = event.clientX
  const startY = event.clientY
  let dragged = false

  return {
    move(clientX: number, clientY: number) {
      const dx = clientX - startX
      const dy = clientY - startY
      if (!dragged && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      dragged = true
      apply(dx, dy)
    },
    end: () => ({ dragged }),
  }
}
