export interface EnvError {
  key: string
  message: string
}

const TG_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{35,}$/

export function validateEnv(env: Record<string, string>): EnvError[] {
  const errors: EnvError[] = []

  // TELEGRAM_BOT_TOKEN — required, must match pattern
  const token = env['TELEGRAM_BOT_TOKEN']
  if (!token) {
    errors.push({ key: 'TELEGRAM_BOT_TOKEN', message: 'Required. Get from @BotFather.' })
  } else if (!TG_TOKEN_REGEX.test(token)) {
    errors.push({ key: 'TELEGRAM_BOT_TOKEN', message: 'Invalid format. Expected: 123456789:ABCdef...' })
  }

  // ALLOWED_CHAT_ID — optional, but if set must be a number
  const chatId = env['ALLOWED_CHAT_ID']
  if (chatId && !/^-?\d+$/.test(chatId)) {
    errors.push({ key: 'ALLOWED_CHAT_ID', message: 'Must be a number. Get via /chatid command.' })
  }

  // GROQ_API_KEY — optional, but if set must start with gsk_
  const groq = env['GROQ_API_KEY']
  if (groq && !groq.startsWith('gsk_')) {
    errors.push({ key: 'GROQ_API_KEY', message: 'Expected to start with gsk_' })
  }

  // GOOGLE_API_KEY — optional, but if set must be non-empty
  const google = env['GOOGLE_API_KEY']
  if (google !== undefined && google.trim() === '') {
    errors.push({ key: 'GOOGLE_API_KEY', message: 'Cannot be empty if specified.' })
  }

  return errors
}

export async function verifyTelegramToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await res.json() as { ok: boolean; result?: { first_name: string; username: string } }
    if (data.ok && data.result) {
      return { ok: true, botName: `@${data.result.username} (${data.result.first_name})` }
    }
    return { ok: false, error: 'Invalid token or bot not found.' }
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
