import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readEnvFile, BOT_NAME, BOT_DIR } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const env = readEnvFile()

// Propagate admin settings from .env to process.env (used by admin/auth.ts, admin/on-demand.ts)
for (const key of ['ADMIN_PORT', 'ADMIN_HOST', 'ADMIN_TOKEN']) {
  if (env[key] && !process.env[key]) process.env[key] = env[key]
}

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

// Embeddings (semantic search)
export const EMBEDDINGS_ENABLED = (env['EMBEDDINGS_ENABLED'] ?? 'true') === 'true'
export const EMBEDDING_SOCK_PATH = env['EMBEDDING_SOCK_PATH'] ?? resolve(PROJECT_ROOT, 'store', 'embedding.sock')

// Memory system
export const NIGHT_OWL_HOUR = parseInt(env['NIGHT_OWL_HOUR'] ?? '4', 10)
export const USER_PREVIEW_LEN = parseInt(env['USER_PREVIEW_LEN'] ?? '200', 10)
export const ASSISTANT_PREVIEW_LEN = parseInt(env['ASSISTANT_PREVIEW_LEN'] ?? '300', 10)
export const MIN_MSG_LEN_TO_SAVE = parseInt(env['MIN_MSG_LEN_TO_SAVE'] ?? '20', 10)
export const MIN_ASSISTANT_LEN_TO_SAVE = parseInt(env['MIN_ASSISTANT_LEN_TO_SAVE'] ?? '50', 10)
export const MAX_ASSISTANT_MEMORY_LEN = parseInt(env['MAX_ASSISTANT_MEMORY_LEN'] ?? '500', 10)

// Guest mode (Bot API 10.0)
export const GUEST_MODE_ENABLED = (env['GUEST_MODE_ENABLED'] ?? 'true') === 'true'

// Rich messages (Bot API 10.1) — structured answers + draft streaming in private chats.
// Default enabled; set RICH_MESSAGES_ENABLED=0 to disable and keep the HTML/chunked path.
export const RICH_MESSAGES_ENABLED = (env['RICH_MESSAGES_ENABLED'] ?? '1') !== '0'
// Draft-стрімінг (sendRichMessageDraft) — DEFAULT OFF: десктопні клієнти Telegram
// (macOS/Windows, липень 2026) крашаться при швидких оновленнях rich-чернетки.
// Увімкнути: RICH_DRAFT_ENABLED=1 (iOS/Android рендерять коректно).
export const RICH_DRAFT_ENABLED = env['RICH_DRAFT_ENABLED'] === '1'

// Full process log — chained progress messages without eviction.
// When enabled, the progress reporter never drops lines: once a message
// approaches the Telegram limit it is frozen and a fresh linked message
// continues the log, so the entire thinking/tool/stage process stays visible.
// Default enabled; set PROGRESS_FULL_LOG=0 for the legacy single-message
// (20-line eviction) behaviour.
export const PROGRESS_FULL_LOG = (env['PROGRESS_FULL_LOG'] ?? '1') !== '0'

// Debug
export const DEBUG_CONTEXT = (env['DEBUG_CONTEXT'] ?? '') === 'true'
