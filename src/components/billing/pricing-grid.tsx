import { ArrowRight } from 'lucide-react'
import { BILLING_PLAN_CATALOG } from '@/lib/billing/catalog'

export const PRICING_TIERS = [
  {
    name: 'Individual',
    price: BILLING_PLAN_CATALOG.individual.price,
    cadence: '/ month',
    desc: 'For solo builders getting real work out of AI.',
    features: ['1 seat included', '10,000 credits / month', '5 agents · 5 flows', '1 core specialist area', 'Unlimited knowledge & connections'],
    href: '/api/stripe/checkout?plan=individual',
    cta: 'Start 14-day trial',
    featured: false,
  },
  {
    name: 'Team',
    price: BILLING_PLAN_CATALOG.team.price,
    cadence: '/ month',
    desc: 'For teams running shared agents and workflows.',
    features: ['10 seats included', '50,000 credits / month', '25 agents · 25 flows', 'Every core specialist area', 'Knowledge sync, sharing & history'],
    href: '/api/stripe/checkout?plan=team',
    cta: 'Start 14-day trial',
    featured: true,
  },
  {
    name: 'Business',
    price: BILLING_PLAN_CATALOG.business.price,
    cadence: '/ month',
    desc: 'For companies scaling AI across departments.',
    features: ['20 seats included', '200,000 credits / month', 'Unlimited agents & flows', 'Unlimited knowledge & connections', 'Priority support & security scopes'],
    href: '/api/stripe/checkout?plan=business',
    cta: 'Start 14-day trial',
    featured: false,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: '',
    desc: 'For organizations with bespoke security and scale needs.',
    features: ['Custom seats & credits', 'Unlimited agents, flows & integrations', 'Custom integrations & SLAs', 'Dedicated onboarding'],
    href: '/contact?reason=enterprise',
    cta: 'Contact sales',
    featured: false,
  },
] as const

/** Shared pricing surface used by marketing and the paid-activation gate. */
export function PricingGrid() {
  return (
    <div className="border border-border">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
        {PRICING_TIERS.map((tier, index) => (
          <div
            key={tier.name}
            className={`flex flex-col p-8 ${index < 3 ? 'border-border lg:border-r' : ''} ${index > 0 ? 'border-t border-border lg:border-t-0' : ''} ${tier.featured ? 'bg-accent/40' : ''}`}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] uppercase tracking-[0.15em] text-muted-foreground">{tier.name}</h3>
              {tier.featured && (
                <span className="border border-foreground/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-foreground/70">Popular</span>
              )}
            </div>
            <div className="mt-4 flex items-baseline gap-1.5">
              <span className="text-[2rem] font-[500] tracking-[-0.03em] text-foreground">{tier.price}</span>
              {tier.cadence && <span className="text-[13px] text-muted-foreground">{tier.cadence}</span>}
            </div>
            <p className="mt-3 text-[13px] leading-[1.6] text-muted-foreground">{tier.desc}</p>
            <ul className="mt-6 flex-1 space-y-2.5">
              {tier.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-[13px] text-foreground/80">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary" />
                  {feature}
                </li>
              ))}
            </ul>
            <a
              href={tier.href}
              className={`mt-8 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-[13px] font-medium transition-colors ${
                tier.featured
                  ? 'bg-foreground text-background hover:bg-foreground/90'
                  : 'border border-foreground/40 text-foreground hover:bg-foreground hover:text-background'
              }`}
            >
              {tier.cta}
              <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}
