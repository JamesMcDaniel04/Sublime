import * as React from "react"

import { cn } from "@/lib/utils"

interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
}

function PageHeader({ eyebrow, title, description, actions, className, ...props }: PageHeaderProps) {
  return (
    <div
      className={cn("flex flex-wrap items-end justify-between gap-4 animate-fade-in-up", className)}
      {...props}
    >
      <div className="space-y-1.5">
        {eyebrow && <p className="eyebrow flex items-center gap-2 text-[#18485C] before:h-px before:w-5 before:bg-[#FF6B35]">{eyebrow}</p>}
        <h1 className="text-3xl font-semibold leading-tight tracking-[-0.025em] text-[#062F33]">{title}</h1>
        {description && <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export { PageHeader }
