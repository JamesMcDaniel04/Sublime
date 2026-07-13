/** Ready-to-paste Slack app manifest so creating the Slack app is copy-paste.
 * NOTE: the design doc listed "message.channels" among the scopes — that is
 * an EVENT name; the real read scope for channel messages is channels:history. */
export function buildSlackManifest(args: { appName: string; ingressUrl: string; commands?: string[] }): Record<string, unknown> {
  const commands = Array.from(new Set((args.commands ?? []).map((command) => '/' + command.trim().replace(/^\//, '')).filter((command) => command !== '/')))
  return {
    display_information: { name: args.appName, description: 'Runs Sublime flows from Slack' },
    features: {
      bot_user: { display_name: args.appName, always_online: true },
      ...(commands.length
        ? {
            slash_commands: commands.map((command) => ({
              command,
              url: args.ingressUrl,
              description: 'Runs a Sublime flow',
              should_escape: false,
            })),
          }
        : {}),
    },
    oauth_config: {
      scopes: { bot: ['app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'commands', 'groups:read', 'im:history', 'im:read', 'users:read'] },
    },
    settings: {
      event_subscriptions: {
        request_url: args.ingressUrl,
        bot_events: ['app_mention', 'message.channels', 'message.im'],
      },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}
