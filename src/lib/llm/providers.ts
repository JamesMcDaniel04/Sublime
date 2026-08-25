/**
 * The model provider seam.
 *
 * n8n offers 24 language models; Sublime had three wires — Claude, Qwen and
 * OpenAI — all hardcoded. A workspace that standardised on Bedrock, must use
 * Azure for procurement reasons, or wants a local Ollama could not express
 * that. Not "a seam we had not built a UI for": there was no seam.
 *
 * **The leverage is that almost none of those 24 need their own adapter.**
 * Groq, OpenRouter, DeepSeek, Together, Mistral, xAI, Fireworks, Nvidia, Azure
 * and Ollama are all "an OpenAI-compatible endpoint at a different base URL".
 * So the seam is a registry of descriptors plus two wire implementations, not
 * twenty-four integrations.
 *
 * Configured by ENVIRONMENT rather than a table: a self-hosted deploy adds a
 * provider without a migration, an unconfigured provider is simply absent
 * rather than a broken menu entry, and provider keys stay out of the database
 * alongside the ones already there.
 *
 *   LLM_PROVIDER_<NAME>_BASE_URL   required — the OpenAI-compatible endpoint
 *   LLM_PROVIDER_<NAME>_API_KEY    required — refused without it
 *   LLM_PROVIDER_<NAME>_MODELS     optional — comma-separated model ids
 */

export type ProviderWire = 'anthropic' | 'openai'

export interface ProviderDescriptor {
  /** Stable lowercase id, used in config and logs. */
  id: string
  label: string
  /** Which request/response shape the runtime speaks to it. */
  wire: ProviderWire
  /** Absent for a built-in that uses its SDK's default endpoint. */
  baseUrl?: string
  /** Env var holding the key. */
  apiKeyEnv: string
  /** Models this provider serves. Empty means "anything it accepts". */
  models: string[]
  /** Prefixes that identify a model as this provider's, for resolution. */
  modelPrefixes?: string[]
}

/**
 * Providers Sublime ships with. Each is present only when its key is set —
 * the same rule custom providers follow, so there is one story.
 */
export const BUILT_IN_PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    wire: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [],
    modelPrefixes: ['claude'],
  },
  {
    id: 'qwen',
    label: 'Qwen',
    wire: 'anthropic', // Qwen is served over the Anthropic wire — see llm/qwen.ts.
    apiKeyEnv: 'QWEN_API_KEY',
    models: [],
    modelPrefixes: ['qwen'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wire: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [],
    modelPrefixes: ['gpt-', 'o1', 'o3', 'o4'],
  },
]

const CUSTOM_RE = /^LLM_PROVIDER_([A-Z0-9]+)_BASE_URL$/

/**
 * Plaintext is allowed ONLY to a loopback host.
 *
 * A self-hosted Ollama on localhost is the reason this is permitted at all.
 * Allowing plaintext to a remote host would send the API key and every prompt
 * over the wire in the clear, which is not a trade a config typo should be
 * able to make silently.
 */
function endpointAcceptable(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
}

/**
 * Every provider available in this environment.
 *
 * A provider missing its key, missing its base URL, or naming an unusable
 * endpoint is REFUSED rather than registered — the alternative is a menu entry
 * that fails at call time with an opaque 401, long after the person who
 * mistyped it has moved on.
 */
export function resolveProviders(env: Record<string, string | undefined>): ProviderDescriptor[] {
  const providers: ProviderDescriptor[] = BUILT_IN_PROVIDERS.filter((provider) => Boolean(env[provider.apiKeyEnv]?.trim()))

  for (const [key, value] of Object.entries(env)) {
    const match = CUSTOM_RE.exec(key)
    if (!match || !value?.trim()) continue
    const name = match[1]
    const apiKeyEnv = `LLM_PROVIDER_${name}_API_KEY`
    if (!env[apiKeyEnv]?.trim()) continue
    const baseUrl = value.trim()
    if (!endpointAcceptable(baseUrl)) continue

    providers.push({
      id: name.toLowerCase(),
      label: name.charAt(0) + name.slice(1).toLowerCase(),
      // Custom providers are OpenAI-compatible by definition: that is the
      // shape this seam exists to accept.
      wire: 'openai',
      baseUrl,
      apiKeyEnv,
      models: (env[`LLM_PROVIDER_${name}_MODELS`] ?? '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    })
  }

  return providers
}

/**
 * Which provider serves this model.
 *
 * An explicit `models` listing wins over a prefix, so a custom provider can
 * claim a model whose name looks like someone else's. An unknown model returns
 * undefined rather than guessing — sending a prompt to the wrong provider is a
 * worse failure than refusing to send it.
 */
export function providerForModel(providers: ProviderDescriptor[], model: string): ProviderDescriptor | undefined {
  const name = model.trim().toLowerCase()
  if (!name) return undefined
  const listed = providers.find((provider) => provider.models.some((entry) => entry.toLowerCase() === name))
  if (listed) return listed
  return providers.find((provider) => provider.modelPrefixes?.some((prefix) => name.startsWith(prefix)))
}
