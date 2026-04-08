/**
 * Listener transcript analysis — extract significant facts from room conversation transcripts.
 * Uses Claude Agent SDK (same auth as bot — OAuth or API key).
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { getBackgroundModel, parseModelConfig } from './model.js'
import { ALLOWED_CHAT_ID } from './config.js'

export interface AnalysisItem {
  text: string
  topic: string
  tags: string
  time?: string  // HH:MM — which chunk this fact belongs to
}

export interface AnalysisResult {
  facts: (string | AnalysisItem)[]
  decisions: (string | AnalysisItem)[]
  tasks: (string | AnalysisItem)[]
  topics: string[]
  summary: string
  language: string
  transcriptQuality: 'good' | 'poor' | 'garbage'
  suggestedLanguage: string | null
}

/** Normalize item — handle both old string format and new object format */
export function normalizeItem(item: string | AnalysisItem): AnalysisItem {
  if (typeof item === 'string') return { text: item, topic: 'general', tags: '' }
  return item
}

const EMPTY: AnalysisResult = {
  facts: [],
  decisions: [],
  tasks: [],
  topics: [],
  summary: '',
  language: 'unknown',
  transcriptQuality: 'garbage',
  suggestedLanguage: null,
}

const ANALYSIS_PROMPT = `Analyze this room conversation transcript. Extract ONLY facts worth remembering long-term.

TRANSCRIPT:
{TEXT}

JSON response:
{
  "transcriptQuality": "good | poor | garbage",
  "suggestedLanguage": "uk | ru | en | null",
  "facts": [{"text": "fact content", "topic": "one-word-english-topic", "tags": "many,tags,in,both,languages", "time": "HH:MM"}],
  "decisions": [{"text": "decision content", "topic": "one-word-english-topic", "tags": "tags", "time": "HH:MM"}],
  "tasks": [{"text": "task content", "topic": "one-word-english-topic", "tags": "tags", "time": "HH:MM"}],
  "topics": ["one-word English topics for this chunk"],
  "language": "primary language code (uk, en, ru, etc.)"
}

TOPIC & TAGS RULES:
- topic: ONE English word, lowercase (health, work, family, finance, home, tech, food, travel, education, legal)
- tags: comma-separated, 5-10 tags in BOTH languages for better search. Include: synonyms, translations, related terms
  Example fact "Прийом у лікаря в п'ятницю": topic="health", tags="лікар,doctor,прийом,appointment,п'ятниця,friday,медицина,medicine"
- time: if transcript has [HH:MM] time markers, set the time of the segment where this fact was mentioned. If no markers, omit.

QUALITY CHECK (do first):
- "good" = coherent text, one primary language
- "poor" = mixed languages, partial gibberish (common: Ukrainian/Russian misrecognized as other language)
- "garbage" = mostly nonsense syllables from wrong language recognition
- If poor/garbage: set suggestedLanguage to the language you think was actually spoken (usually "uk" or "ru"), return empty arrays

SIGNIFICANCE TEST: "Чи буде це корисно через 3 місяці?"

Зберігай (1-2 речення MAX на факт):
- Нові контакти, імена, дати народження
- Рішення з наслідками ("вирішив продати X", "обрав лікаря Y")
- Здоров'я: діагнози, ліки, результати аналізів
- Конкретні дати, час, дедлайни, зустрічі
- Числа які мають значення (ціна, адреса, телефон, сума)
- Зобов'язання або обіцянки ("я обіцяв зробити X до п'ятниці")
- Сезонні віхи та життєві події ("почали новий сезон в теплиці", "переїхали", "змінили роботу")
- Побутові факти з конкретикою ("купили новий холодильник", "зламалась машина")

НІКОЛИ не зберігай:
- Привітання, small talk без змісту
- Думки без рішень ("може колись...", "було б непогано...")
- Тимчасові дані: погода, курс валют, що гуглиться за 5 сек
- Загальновідоме, новини дня

МОВА: summary і факти пиши МОВОЮ транскрипту (якщо транскрипт українською — відповідь українською).

Очікуваний результат: 0-5 фактів на 5-хвилинний запис.
Respond with ONLY valid JSON, no markdown.`

// Whisper hallucinates repetitive phrases on silence/noise (YouTube training data artifacts)
const HALLUCINATION_PATTERNS = [
  // Ukrainian
  /Дякую за перегляд!?/gi,
  /Дякую за підписку!?/gi,
  /Підписуйтесь на канал!?/gi,
  /Ставте лайки!?/gi,
  /Субтитри зроблені/gi,
  /Редактор субтитрів/gi,
  // Russian
  /Спасибо за просмотр!?/gi,
  /Спасибо за подписку!?/gi,
  /Подписывайтесь на канал!?/gi,
  /Ставьте лайки!?/gi,
  /Субтитры сделал\S*/gi,
  /Продолжение следует\.{0,3}/gi,
  // English
  /Thank you for watching!?/gi,
  /Thanks for watching!?/gi,
  /Please subscribe!?/gi,
  /Like and subscribe!?/gi,
  /Don't forget to subscribe!?/gi,
  /Hit the bell!?/gi,
  /See you in the next video!?/gi,
  // Generic Whisper noise
  /Звук вентиляції\.?/gi,
  /Звук дзвінку\.?/gi,
]

export function cleanWhisperHallucinations(text: string): string {
  let cleaned = text
  for (const pattern of HALLUCINATION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }
  // Strip standalone filler words at start/end (all languages)
  cleaned = cleaned.replace(/^(\s*(Дякую|Спасибо|Thank you|Thanks)\.?\s*)+/gi, '')
  cleaned = cleaned.replace(/(\s*(Дякую|Спасибо|Thank you|Thanks)\.?\s*)+$/gi, '')
  return cleaned.replace(/\s{2,}/g, ' ').trim()
}

// Map common Ukrainian/Russian topic phrases to single English words
const TOPIC_MAP: Record<string, string> = {
  'здоров': 'health', 'медич': 'health', 'лікар': 'health', 'діагноз': 'health', 'аналіз': 'health',
  'здоровь': 'health', 'врач': 'health', 'медицин': 'health',
  'робот': 'work', 'праця': 'work', 'проект': 'work', 'бізнес': 'business',
  'розроб': 'tech', 'програм': 'tech', 'код': 'tech', 'бот': 'tech', 'сервер': 'tech',
  'будів': 'construction', 'ремонт': 'construction', 'матеріал': 'construction',
  'інженер': 'engineering', 'конструкц': 'engineering', 'купол': 'engineering',
  'земел': 'property', 'ділянк': 'property', 'будинок': 'property', 'теплиц': 'home',
  'сім': 'family', 'родин': 'family', 'діт': 'family', 'мам': 'family',
  'фінанс': 'finance', 'гроші': 'finance', 'оплат': 'finance', 'ціна': 'finance',
  'патент': 'legal', 'юрид': 'legal', 'ліценз': 'legal',
  'їж': 'food', 'кух': 'food', 'готув': 'food',
  'подорож': 'travel', 'поїзд': 'travel',
  'навчан': 'education', 'курс': 'education',
  'авто': 'auto', 'машин': 'auto',
}

/** Normalize topic to one lowercase English word */
export function normalizeTopic(raw: string): string {
  if (!raw) return 'general'
  const lower = raw.toLowerCase().trim()
  // Already a short English word
  if (/^[a-z]{2,15}$/.test(lower)) return lower
  // Try to map from known patterns
  for (const [pattern, topic] of Object.entries(TOPIC_MAP)) {
    if (lower.includes(pattern)) return topic
  }
  // Last resort: take first word, transliterate if needed
  const firstWord = lower.split(/[\s,]+/)[0]
  if (/^[a-z]+$/.test(firstWord) && firstWord.length <= 15) return firstWord
  return 'general'
}

export async function analyzeTranscript(text: string): Promise<AnalysisResult> {
  const cleanedText = cleanWhisperHallucinations(text)
  if (!cleanedText || cleanedText.length < 5) return { ...EMPTY, summary: '' }
  const prompt = ANALYSIS_PROMPT.replace('{TEXT}', cleanedText)

  // Use the bot's configured background model (admin-set), with -1m suffix handling.
  const chatId = ALLOWED_CHAT_ID || '0'
  const { model: sdkModel } = parseModelConfig(getBackgroundModel(chatId))

  try {
    let resultText = ''

    for await (const event of query({
      prompt: prompt,
      options: {
        model: sdkModel,
        maxTurns: 1,
      },
    })) {
      const msg = event as SDKMessage
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            resultText += block.text
          }
        }
      }
    }

    if (!resultText) return { ...EMPTY, summary: text.slice(0, 200) }

    // Strip markdown code fences if present
    const cleaned = resultText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('Analysis error:', e)
    return { ...EMPTY, summary: text.slice(0, 200) }
  }
}
