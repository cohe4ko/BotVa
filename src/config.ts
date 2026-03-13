import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readEnvFile, BOT_NAME, BOT_DIR } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const env = readEnvFile()

export const PROJECT_ROOT = resolve(__dirname, '..')
// Store is bot-specific: bots/<name>/store
export const STORE_DIR = resolve(BOT_DIR, 'store')

export { BOT_NAME, BOT_DIR }

export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? ''

export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000

// Telegraph
export const TELEGRAPH_ENABLED = (env['TELEGRAPH_ENABLED'] ?? 'true') === 'true'

// Agent watchdog
export const AGENT_WATCHDOG_WARN_SECONDS = parseInt(env['AGENT_WATCHDOG_WARN_SECONDS'] ?? '60', 10)
export const AGENT_WATCHDOG_TIMEOUT_MS = parseInt(env['AGENT_WATCHDOG_TIMEOUT_MS'] ?? '600000', 10) // 10 min

// Google API key (used for Stagehand browser AI)
export const GOOGLE_API_KEY = env['GOOGLE_API_KEY'] ?? ''

// Bitrix24 CRM
export const BITRIX24_WEBHOOK_URL = env['BITRIX24_WEBHOOK_URL'] ?? ''

// Google Workspace
export const GOOGLE_OAUTH_CLIENT_ID = env['GOOGLE_OAUTH_CLIENT_ID'] ?? ''
export const GOOGLE_OAUTH_CLIENT_SECRET = env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? ''
export const USER_GOOGLE_EMAIL = env['USER_GOOGLE_EMAIL'] ?? ''

// Home Assistant
export const HA_URL = env['HA_URL'] ?? ''
export const HA_TOKEN = env['HA_TOKEN'] ?? ''

// Memory system
export const MEMORY_SALIENCE_DECAY = parseFloat(env['MEMORY_SALIENCE_DECAY'] ?? '0.98')
export const MEMORY_SALIENCE_MIN = parseFloat(env['MEMORY_SALIENCE_MIN'] ?? '0.1')
export const MEMORY_SALIENCE_MAX = parseFloat(env['MEMORY_SALIENCE_MAX'] ?? '5.0')
export const MEMORY_SALIENCE_BOOST = parseFloat(env['MEMORY_SALIENCE_BOOST'] ?? '0.1')
export const NIGHT_OWL_HOUR = parseInt(env['NIGHT_OWL_HOUR'] ?? '4', 10)
export const USER_PREVIEW_LEN = parseInt(env['USER_PREVIEW_LEN'] ?? '200', 10)
export const ASSISTANT_PREVIEW_LEN = parseInt(env['ASSISTANT_PREVIEW_LEN'] ?? '300', 10)
export const MIN_MSG_LEN_TO_SAVE = parseInt(env['MIN_MSG_LEN_TO_SAVE'] ?? '20', 10)
export const MIN_ASSISTANT_LEN_TO_SAVE = parseInt(env['MIN_ASSISTANT_LEN_TO_SAVE'] ?? '50', 10)
export const MAX_ASSISTANT_MEMORY_LEN = parseInt(env['MAX_ASSISTANT_MEMORY_LEN'] ?? '500', 10)
