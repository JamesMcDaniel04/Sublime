import * as React from "react"

import { cn } from "@/lib/utils"

interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
  /** Optional lucide icon rendered in a bordered tile beside the title. */
  icon?: React.ComponentType<{ className?: string }>
}

function PageHeader({ eyebrow, title, description, actions, icon: Icon, className, ...props }: PageHeaderProps) {
  return (
    <div
      className={cn("flex flex-wrap items-end justify-between gap-4 animate-fade-in-up", className)}
      {...props}
    >
      <div className="space-y-1.5">
        {eyebrow && <p className="eyebrow flex items-center gap-2 text-muted-foreground before:h-px before:w-5 before:bg-foreground">{eyebrow}</p>}
        <div className="flex items-center gap-3">
          {Icon && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-foreground">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
          )}
          <h1 className="text-3xl font-semibold leading-tight tracking-[-0.025em] text-foreground">{title}</h1>
        </div>
        {description && <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export { PageHeader }
