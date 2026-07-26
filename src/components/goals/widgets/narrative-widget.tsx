'use client'

import { Sparkles } from 'lucide-react'
import { Card } from '@/components/ui/card'
import type { WidgetProps } from './goal-dashboard'

export function NarrativeWidget({ config }: WidgetProps) {
  if (typeof config.text !== 'string' || !config.text.trim()) return null
  return (
    <Card className="flex items-start gap-3 border-dashed bg-muted/30 p-4">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{config.text}</p>
    </Card>
  )
}
