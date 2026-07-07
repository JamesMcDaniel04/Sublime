"use client"

import * as React from "react"
import { animate } from "motion"
import { useReducedMotion } from "motion/react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"

function AnimatedNumber({ value }: { value: number }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduced) {
      el.textContent = value.toLocaleString()
      return
    }
    const controls = animate(0, value, {
      duration: 0.8,
      ease: [0.25, 1, 0.5, 1],
      onUpdate: (v) => {
        el.textContent = Math.round(v).toLocaleString()
      },
    })
    return () => controls.stop()
  }, [value, reduced])
  return <span ref={ref} className="tabular-nums" />
}

interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string
  value: number | string
  hint?: string
  icon?: LucideIcon
}

function StatTile({ label, value, hint, icon: Icon, className, ...props }: StatTileProps) {
  return (
    <Card variant="raised" className={cn("p-5", className)} {...props}>
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-horizon-500" aria-hidden="true" />}
      </div>
      <p className="mt-2 font-mono text-3xl font-bold text-foreground">
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  )
}

export { StatTile }
