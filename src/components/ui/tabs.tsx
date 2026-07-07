"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

// Track the active value + a per-instance layout id so TabsTrigger can render
// a shared-layout indicator that springs between triggers.
const TabsCtx = React.createContext<{ active?: string; layoutId: string }>({
  layoutId: "",
})

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ defaultValue, value, onValueChange, ...props }, ref) => {
  const [internal, setInternal] = React.useState(defaultValue)
  const layoutId = React.useId()
  return (
    <TabsCtx.Provider value={{ active: value ?? internal, layoutId }}>
      <TabsPrimitive.Root
        ref={ref}
        defaultValue={defaultValue}
        value={value}
        onValueChange={(v) => {
          setInternal(v)
          onValueChange?.(v)
        }}
        {...props}
      />
    </TabsCtx.Provider>
  )
})
Tabs.displayName = TabsPrimitive.Root.displayName

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-10 items-center justify-center rounded-lg bg-graphite-100 p-1 text-graphite-600",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, value, children, ...props }, ref) => {
  const { active, layoutId } = React.useContext(TabsCtx)
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      className={cn(
        "relative inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-graphite-600 transition-colors duration-fast hover:text-graphite-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-graphite-900",
        className
      )}
      {...props}
    >
      {active === value && (
        <motion.span
          layoutId={`${layoutId}-indicator`}
          className="absolute inset-0 rounded-md bg-white shadow-1"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
          aria-hidden="true"
        />
      )}
      <span className="relative z-10">{children}</span>
    </TabsPrimitive.Trigger>
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 animate-fade-in ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
