import { PageHeader } from '@/components/ui/page-header'
import { SignalAutomationsPanel } from '@/components/signals/signal-automations-panel'

export default function SignalsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Automations"
        title="Signals"
        description="Route incoming workspace events to the right agents."
      />
      <SignalAutomationsPanel />
    </div>
  )
}
