import { Globe, PencilLine } from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { SOURCE_ICON_SLUGS, SOURCE_LABELS } from '@/components/goals/source-labels'
import type { MetricSource } from '@/lib/goals/metric-sources'
import { cn } from '@/lib/utils'

/**
 * Brand mark for a metric source, used wherever a source is listed: the
 * template card and detail dialog, the wizard's source picker, and the metric
 * binding fields.
 *
 * Resolves through SOURCE_ICON_SLUGS instead of IntegrationChip's label
 * guess, and renders a glyph — not IntegrationLogo's initial tile — for the two
 * sources that have no company behind them. A source missing from the table
 * still tries the logo path, so it degrades to IntegrationLogo's own fallback
 * chain rather than silently becoming a pencil.
 */
export function SourceLogo({
  source,
  className,
}: {
  source: string
  className?: string
}) {
  const slug =
    source in SOURCE_ICON_SLUGS ? SOURCE_ICON_SLUGS[source as MetricSource] : source
  const box = cn('h-5 w-5 shrink-0', className)

  if (slug) {
    return (
      <IntegrationLogo
        name={SOURCE_LABELS[source] ?? source}
        slug={slug}
        className={box}
      />
    )
  }

  const Glyph = source === 'url' ? Globe : PencilLine
  return <Glyph className={cn(box, 'text-muted-foreground')} aria-hidden />
}
