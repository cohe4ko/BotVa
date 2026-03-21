import { getChatSetting, setChatSetting } from './db.js'

export interface ModelInfo {
  id: string
  label: string
  description: string
}

export const MODELS: ModelInfo[] = [
  { id: 'opus-1m', label: 'Opus 1M', description: 'Most capable, 1M context' },
  { id: 'opus', label: 'Opus 200k', description: 'Most capable' },
  { id: 'sonnet-1m', label: 'Sonnet 1M', description: 'Balanced, 1M context' },
  { id: 'sonnet', label: 'Sonnet 200k', description: 'Balanced' },
  { id: 'haiku', label: 'Haiku', description: 'Fast & light' },
]

const DEFAULT_MODEL = 'sonnet'

// In-memory cache for fast access during agent calls
const chatModels = new Map<string, string>()

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

export function getTemperature(chatId: string): number | undefined {
  const val = getChatSetting(chatId, 'temperature')
  if (val === undefined) return undefined
  const num = parseFloat(val)
  return isNaN(num) ? undefined : num
}
