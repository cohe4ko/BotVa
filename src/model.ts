import { getChatSetting, setChatSetting } from './db.js'

export interface ModelInfo {
  id: string
  label: string
  description: string
}

export const MODELS: ModelInfo[] = [
  { id: 'opus', label: 'Opus', description: 'Most capable' },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
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

export function getTemperature(chatId: string): number | undefined {
  const val = getChatSetting(chatId, 'temperature')
  if (val === undefined) return undefined
  const num = parseFloat(val)
  return isNaN(num) ? undefined : num
}
