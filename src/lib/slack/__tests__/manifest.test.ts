import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSlackManifest } from '@/lib/slack/manifest'

test('manifest pre-fills scopes, event subscriptions, and the ingress URL', () => {
  const manifest = buildSlackManifest({ appName: 'Sublime Bot', ingressUrl: 'https://app.test/api/slack/events/bind_1' }) as any
  assert.equal(manifest.display_information.name, 'Sublime Bot')
  // Real scope names (the spec's "message.channels" is an event, not a scope).
  assert.deepEqual(manifest.oauth_config.scopes.bot, [
    'app_mentions:read', 'channels:history', 'chat:write', 'commands', 'im:history', 'im:read',
  ])
  assert.equal(manifest.settings.event_subscriptions.request_url, 'https://app.test/api/slack/events/bind_1')
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ['app_mention', 'message.channels', 'message.im'])
  assert.equal(manifest.settings.socket_mode_enabled, false)
  assert.equal(manifest.features.slash_commands, undefined) // none configured
})

test('slash commands from the org flows are pre-filled with the ingress URL', () => {
  const manifest = buildSlackManifest({
    appName: 'Sublime Bot', ingressUrl: 'https://app.test/api/slack/events/bind_1', commands: ['/deploy', 'status'],
  }) as any
  assert.deepEqual(manifest.features.slash_commands.map((c: any) => c.command), ['/deploy', '/status'])
  assert.ok(manifest.features.slash_commands.every((c: any) => c.url === 'https://app.test/api/slack/events/bind_1'))
})
