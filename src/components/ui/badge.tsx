import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-1",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-1",
        outline: "text-foreground",
        good: "border-transparent bg-[var(--status-good-bg)] text-[var(--status-good-fg)]",
        warn: "border-transparent bg-[var(--status-warn-bg)] text-[var(--status-warn-fg)]",
        risk: "border-transparent bg-[var(--status-risk-bg)] text-[var(--status-risk-fg)]",
        info: "border-transparent bg-[var(--status-info-bg)] text-[var(--status-info-fg)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }