/**
 * The model provider seam.
 *
 * n8n offers 24 language models; Sublime had three wires (Claude, Qwen,
 * OpenAI), all hardcoded. A workspace that standardised on Bedrock, must use
 * Azure for procurement reasons, or wants Gemini for long context could not
 * express that — there was no seam to attach one to.
 *
 * The leverage: almost every provider in that list of 24 speaks either the
 * Anthropic wire or the OPENAI-COMPATIBLE wire. Groq, OpenRouter, DeepSeek,
 * Together, Mistral, xAI, Fireworks, Nvidia, Azure and a local Ollama are all
 * "OpenAI-compatible endpoint with a different base URL". So the seam is a
 * registry of descriptors, not 24 adapters.
 *
 * Configured by environment so a self-hosted deploy can add one without a
 * migration, and so an unconfigured provider is simply absent rather than a
 * broken menu entry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviders, providerForModel, BUILT_IN_PROVIDERS } from '../providers'

const env = (over: Record<string, string | undefined> = {}) => ({
  ANTHROPIC_API_KEY: 'sk-ant-x',
  ...over,
})

test('a provider with no key configured is absent, not broken', () => {
  const providers = resolveProviders({})
  assert.equal(providers.length, 0)
})

test('the built-in Anthropic provider appears when its key is set', () => {
  const providers = resolveProviders(env())
  assert.ok(providers.some((p) => p.id === 'anthropic'))
})

test('OpenAI appears on its own key', () => {
  const providers = resolveProviders(env({ OPENAI_API_KEY: 'sk-x' }))
  assert.ok(providers.some((p) => p.id === 'openai'))
})

// The part that opens the seam: a provider nobody hardcoded.
test('a custom OpenAI-compatible provider is registered from the environment', () => {
  const providers = resolveProviders(env({
    LLM_PROVIDER_GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
    LLM_PROVIDER_GROQ_API_KEY: 'gsk-x',
    LLM_PROVIDER_GROQ_MODELS: 'llama-3.3-70b,mixtral-8x7b',
  }))
  const groq = providers.find((p) => p.id === 'groq')
  assert.ok(groq, 'a configured custom provider should appear')
  assert.equal(groq.wire, 'openai')
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1')
  assert.deepEqual(groq.models, ['llama-3.3-70b', 'mixtral-8x7b'])
})

test('several custom providers can coexist', () => {
  const providers = resolveProviders(env({
    LLM_PROVIDER_GROQ_BASE_URL: 'https://a', LLM_PROVIDER_GROQ_API_KEY: 'k1',
    LLM_PROVIDER_TOGETHER_BASE_URL: 'https://b', LLM_PROVIDER_TOGETHER_API_KEY: 'k2',
  }))
  const ids = providers.map((p) => p.id)
  assert.ok(ids.includes('groq') && ids.includes('together'))
})

// A base URL with no key is a misconfiguration that would fail at call time
// with an opaque 401; better to refuse to register it.
test('a custom provider missing its key is not registered', () => {
  const providers = resolveProviders(env({ LLM_PROVIDER_GROQ_BASE_URL: 'https://a' }))
  assert.ok(!providers.some((p) => p.id === 'groq'))
})

test('a custom provider missing its base URL is not registered', () => {
  const providers = resolveProviders(env({ LLM_PROVIDER_GROQ_API_KEY: 'k' }))
  assert.ok(!providers.some((p) => p.id === 'groq'))
})

// A non-https endpoint is allowed only for a loopback host: a self-hosted
// Ollama is the reason, and permitting arbitrary plaintext would send API
// keys and prompts over the wire in the clear.
test('a plaintext base URL is refused unless it is loopback', () => {
  const remote = resolveProviders(env({ LLM_PROVIDER_X_BASE_URL: 'http://example.com/v1', LLM_PROVIDER_X_API_KEY: 'k' }))
  assert.ok(!remote.some((p) => p.id === 'x'), 'plaintext to a remote host should be refused')

  const local = resolveProviders(env({ LLM_PROVIDER_OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1', LLM_PROVIDER_OLLAMA_API_KEY: 'k' }))
  assert.ok(local.some((p) => p.id === 'ollama'), 'a loopback endpoint is the self-hosted case')
})

test('a malformed base URL is refused rather than failing at call time', () => {
  const providers = resolveProviders(env({ LLM_PROVIDER_X_BASE_URL: 'not a url', LLM_PROVIDER_X_API_KEY: 'k' }))
  assert.ok(!providers.some((p) => p.id === 'x'))
})

// ── resolving a model back to its provider ──────────────────────────────────

test('a claude model resolves to the anthropic provider', () => {
  const providers = resolveProviders(env())
  assert.equal(providerForModel(providers, 'claude-sonnet-5')?.id, 'anthropic')
})

test('a model listed by a custom provider resolves to it', () => {
  const providers = resolveProviders(env({
    LLM_PROVIDER_GROQ_BASE_URL: 'https://a', LLM_PROVIDER_GROQ_API_KEY: 'k',
    LLM_PROVIDER_GROQ_MODELS: 'llama-3.3-70b',
  }))
  assert.equal(providerForModel(providers, 'llama-3.3-70b')?.id, 'groq')
})

test('an unknown model resolves to nothing rather than a wrong provider', () => {
  assert.equal(providerForModel(resolveProviders(env()), 'gpt-9-turbo'), undefined)
})

test('every built-in declares a wire the runtime can speak', () => {
  for (const provider of BUILT_IN_PROVIDERS) {
    assert.ok(['anthropic', 'openai'].includes(provider.wire), `${provider.id} has an unknown wire`)
  }
})
