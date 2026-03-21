/**
 * Listener transcript analysis — shared between admin and receiver.
 * Calls Anthropic API to extract significant facts from room conversation transcripts.
 */

export interface AnalysisResult {
  facts: string[]
  decisions: string[]
  tasks: string[]
  topics: string[]
  summary: string
  language: string
  transcriptQuality: 'good' | 'poor' | 'garbage'
  suggestedLanguage: string | null
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

export async function analyzeTranscript(text: string, apiKey?: string): Promise<AnalysisResult> {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || ''
  if (!key) return { ...EMPTY, summary: text.slice(0, 200) }

  const prompt = `Analyze this room conversation transcript. Extract ONLY facts worth remembering long-term.

TRANSCRIPT:
${text}

JSON response:
{
  "transcriptQuality": "good | poor | garbage",
  "suggestedLanguage": "uk | ru | en | null",
  "facts": ["significant facts worth saving to memory"],
  "decisions": ["firm decisions with consequences"],
  "tasks": ["concrete action items with clear next step"],
  "topics": ["main topics discussed"],
  "summary": "2-3 sentence summary",
  "language": "primary language code (uk, en, ru, etc.)"
}

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

НІКОЛИ не зберігай:
- Побутову балаканину, привітання, small talk
- Одноразові події ("дивились фільм", "їли піцу")
- Думки без рішень ("може колись...", "було б непогано...")
- Тимчасові дані: погода, курс валют, що гуглиться за 5 сек
- Загальновідоме, новини дня
- Контекст який має сенс тільки в моменті

Очікуваний результат: 0-3 факти на 5-хвилинний запис. Якщо більше 5 — ти зберігаєш забагато.
Respond with ONLY valid JSON, no markdown.`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      console.error(`Anthropic API error: ${response.status}`)
      return { ...EMPTY, summary: text.slice(0, 200) }
    }

    const data = (await response.json()) as any
    const content = data.content?.[0]?.text || '{}'
    return JSON.parse(content)
  } catch (e) {
    console.error('Analysis error:', e)
    return { ...EMPTY, summary: text.slice(0, 200) }
  }
}
