/**
 * Telegram Observer — project-level paths.
 *
 * The observer is a standalone daemon, not a per-bot process, so it deliberately
 * avoids src/config.ts (which resolves everything relative to BOT_DIR).
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = resolve(__dirname, '..', '..')
export const TG_STORE_DIR = resolve(PROJECT_ROOT, 'store')

export const TG_DB_PATH = resolve(TG_STORE_DIR, 'telegram.db')
export const TG_SESSION_PATH = resolve(TG_STORE_DIR, 'telegram.session')
export const TG_SOCK_PATH = resolve(TG_STORE_DIR, 'telegram.sock')
export const TG_PID_PATH = resolve(TG_STORE_DIR, 'telegram.pid')
export const TG_LOG_PATH = resolve(TG_STORE_DIR, 'telegram-observer.log')
export const TG_MEDIA_DIR = resolve(PROJECT_ROOT, 'workspace', 'telegram', 'media')
