import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-shimmer rounded-md bg-gradient-to-r from-graphite-100 via-graphite-200 to-graphite-100 bg-[length:200%_100%]",
        className
      )}
      aria-hidden="true"
      {...props}
    />
  )
}

export { Skeleton }
