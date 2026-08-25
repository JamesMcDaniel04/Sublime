// scripts/spikes/hubspot-history-probe.mjs
// One-shot: does this portal return dealstage property history?
//
// The search endpoint the HubSpot adapter uses today cannot return property
// history; only the list endpoint can. Everything in the baselines layer that
// measures duration depends on the answer, so this probes it directly before
// any code is built on the assumption.
//
// Usage: NANGO_SECRET_KEY=... node scripts/spikes/hubspot-history-probe.mjs [connectionId] [providerConfigKey]
// With no arguments, lists the available HubSpot connections and exits.
import { Nango } from '@nangohq/node'

const [connectionId, providerConfigKey] = process.argv.slice(2)

if (!process.env.NANGO_SECRET_KEY) {
  console.error('NANGO_SECRET_KEY is required')
  process.exit(1)
}

const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY })

if (!connectionId || !providerConfigKey) {
  const { connections = [] } = await nango.listConnections()
  const hubspot = connections.filter((c) => String(c.provider_config_key ?? '').includes('hubspot'))
  console.log(`total connections: ${connections.length}, hubspot: ${hubspot.length}`)
  for (const connection of hubspot) {
    console.log(`  ${connection.connection_id}  (${connection.provider_config_key})`)
  }
  if (hubspot.length === 0) console.log('\nNo HubSpot connection to probe.')
  else console.log('\nRe-run with: node scripts/spikes/hubspot-history-probe.mjs <connectionId> <providerConfigKey>')
  process.exit(0)
}

const response = await nango.proxy({
  method: 'GET',
  endpoint: '/crm/v3/objects/deals',
  connectionId,
  providerConfigKey,
  params: {
    limit: 5,
    propertiesWithHistory: 'dealstage',
    properties: 'dealname,dealstage,createdate,hubspot_owner_id',
  },
})

const results = response.data?.results ?? []
console.log(`deals returned: ${results.length}`)
for (const deal of results) {
  const history = deal.propertiesWithHistory?.dealstage
  console.log(
    JSON.stringify(
      {
        id: deal.id,
        historyEntries: Array.isArray(history) ? history.length : 0,
        sample: Array.isArray(history)
          ? history.slice(0, 3).map((entry) => ({ value: entry.value, timestamp: entry.timestamp }))
          : null,
      },
      null,
      2,
    ),
  )
}
