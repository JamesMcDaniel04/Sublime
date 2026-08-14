'use client'

import { useCallback, useRef, useState, type ReactNode } from 'react'

/**
 * A right-docked panel the user can widen/narrow by dragging its left edge.
 * Width persists per `storageKey`. Used for the flow builder's config drawer,
 * copilot, and runs panels.
 */
export function ResizablePanel({
  children,
  storageKey,
  defaultWidth = 320,
  min = 280,
  max = 760,
}: {
  children: ReactNode
  storageKey: string
  defaultWidth?: number
  min?: number
  max?: number
}) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth
    const saved = Number(window.localStorage.getItem(storageKey))
    return saved ? Math.min(max, Math.max(min, saved)) : defaultWidth
  })
  const widthRef = useRef(width)

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = widthRef.current
      const onMove = (moveEvent: MouseEvent) => {
        // Panel is on the right, so dragging LEFT (smaller clientX) widens it.
        const next = Math.min(max, Math.max(min, startWidth + (startX - moveEvent.clientX)))
        widthRef.current = next
        setWidth(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        try {
          window.localStorage.setItem(storageKey, String(widthRef.current))
        } catch {
          /* storage unavailable */
        }
      }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [min, max, storageKey],
  )

  /** Shared by the keyboard handler and the double-click reset. */
  const commitWidth = useCallback(
    (next: number) => {
      const clamped = Math.min(max, Math.max(min, next))
      widthRef.current = clamped
      setWidth(clamped)
      try {
        window.localStorage.setItem(storageKey, String(clamped))
      } catch {
        /* storage unavailable */
      }
    },
    [max, min, storageKey],
  )

  return (
    <div className="relative shrink-0" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        // Keyboard equivalent for the drag. A separator with only onMouseDown is
        // mouse-only, which leaves keyboard and switch users unable to resize a
        // core builder panel at all (WCAG 2.1.1). Arrow keys nudge, Shift jumps,
        // Home restores the default — the standard window-splitter pattern.
        // A focusable separator IS the ARIA window-splitter pattern — the
        // rule classifies role="separator" as non-interactive because a plain
        // separator is, but a resizable one is explicitly focusable per the
        // spec. Removing the tabIndex would restore the mouse-only defect this
        // change exists to fix.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label="Resize panel"
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 8
          // Panel is right-docked: ArrowLeft widens, mirroring the drag.
          if (event.key === 'ArrowLeft') commitWidth(widthRef.current + step)
          else if (event.key === 'ArrowRight') commitWidth(widthRef.current - step)
          else if (event.key === 'Home') commitWidth(defaultWidth)
          else return
          event.preventDefault()
        }}
        onMouseDown={onMouseDown}
        onDoubleClick={() => commitWidth(defaultWidth)}
        title="Drag to resize · double-click to reset · arrow keys when focused"
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-indigo-300/60 focus-visible:outline-none focus-visible:bg-ring"
      />
      {children}
    </div>
  )
}
