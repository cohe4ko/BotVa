import { getChatSetting, setChatSetting } from './db.js'

export interface ModelInfo {
  id: string
  label: string
  description: string
}

export const MODELS: ModelInfo[] = [
  { id: 'fable', label: 'Fable 5', description: 'Most capable' },
  { id: 'opus-1m', label: 'Opus 1M', description: 'Most capable, 1M context' },
  { id: 'opus', label: 'Opus 200k', description: 'Most capable' },
  { id: 'sonnet-1m', label: 'Sonnet 1M', description: 'Balanced, 1M context' },
  { id: 'sonnet', label: 'Sonnet 200k', description: 'Balanced' },
  { id: 'haiku', label: 'Haiku', description: 'Fast & light' },
]

export const EFFORTS = ['low', 'medium', 'high', 'max'] as const
export type Effort = typeof EFFORTS[number]

const DEFAULT_MODEL = 'sonnet'
const DEFAULT_BACKGROUND_MODEL = 'sonnet'

// In-memory caches for fast access during agent calls
const chatModels = new Map<string, string>()
const chatBackgroundModels = new Map<string, string>()
const chatEfforts = new Map<string, string>()

export function getModel(chatId: string): string {
  let model = chatModels.get(chatId)
  if (!model) {
    model = getChatSetting(chatId, 'model') ?? DEFAULT_MODEL
    chatModels.set(chatId, model)
  }
  return model
}

export function setModel(chatId: string, model: string): void {
  chatModels.set(chatId, model)
  setChatSetting(chatId, 'model', model)
}

/**
 * Background model — used by memory consolidation, scheduler, listener analysis,
 * and other non-interactive service calls. Set only via admin UI (no /model command).
 */
export function getBackgroundModel(chatId: string): string {
  let model = chatBackgroundModels.get(chatId)
  if (!model) {
    model = getChatSetting(chatId, 'background_model') ?? DEFAULT_BACKGROUND_MODEL
    chatBackgroundModels.set(chatId, model)
  }
  return model
}

export function setBackgroundModel(chatId: string, model: string): void {
  chatBackgroundModels.set(chatId, model)
  setChatSetting(chatId, 'background_model', model)
}

/**
 * Reasoning effort — only for main user chat, not background tasks.
 * Returns undefined when unset, letting SDK apply its adaptive default.
 */
export function getEffort(chatId: string): Effort | undefined {
  let cached = chatEfforts.get(chatId)
  if (cached === undefined) {
    cached = getChatSetting(chatId, 'effort') ?? ''
    chatEfforts.set(chatId, cached)
  }
  return (EFFORTS as readonly string[]).includes(cached) ? (cached as Effort) : undefined
}

export function setEffort(chatId: string, effort: Effort | ''): void {
  chatEfforts.set(chatId, effort)
  setChatSetting(chatId, 'effort', effort)
}

export function getModelLabel(modelId: string): string {
  return MODELS.find(m => m.id === modelId)?.label ?? modelId
}

export function parseModelConfig(modelId: string): { model: string; use1m: boolean } {
  if (modelId.endsWith('-1m')) {
    // Claude CLI uses [1m] suffix in model name to enable 1M context (not --betas flag)
    return { model: modelId.replace('-1m', '') + '[1m]', use1m: true }
  }
  return { model: modelId, use1m: false }
}

/**
 * Resilience fallback for the SDK `fallbackModel` query option: the model to
 * try when the primary one is overloaded or unavailable. Returns a plain model
 * name (no `[1m]`/`-1m` suffix) so the fallback runs at standard context, or
 * undefined when there is no lower tier to fall back to.
 *
 * Chain: fable → sonnet, opus → sonnet, sonnet → haiku, haiku → (none).
 * Accepts any form of the primary name (`opus`, `opus-1m`, `opus[1m]`).
 */
export function getFallbackModel(model: string): string | undefined {
  const base = model.replace(/\[1m\]$/, '').replace(/-1m$/, '')
  const chain: Record<string, string | undefined> = {
    fable: 'sonnet',
    opus: 'sonnet',
    sonnet: 'haiku',
    haiku: undefined,
  }
  return chain[base]
}
