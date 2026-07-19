export const BILLING_PLAN_CATALOG = {
  individual: {
    name: 'Individual',
    price: '$29.99',
    priceWithCadence: '$29.99/mo',
  },
  team: {
    name: 'Team',
    price: '$299',
    priceWithCadence: '$299/mo',
  },
  business: {
    name: 'Business',
    price: '$1,999',
    priceWithCadence: '$1,999/mo',
  },
} as const

export type PaidPlanKey = keyof typeof BILLING_PLAN_CATALOG

