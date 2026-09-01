#!/usr/bin/env node
/**
 * Telegram Observer — daemon entrypoint.
 *
 * Holds one MTProto session for the owner's account, logs messages according to
 * per-chat mode (Tier 0 only — no model calls in this phase), and serves MCP
 * tools over a Unix socket.
 *
 * Run: node dist/telegram/daemon.js   (via scripts/telegram-observer.sh)
 */

import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs'
import { TelegramClient, Api } from 'telegram'
import { NewMessage, Raw } from 'telegram/events/index.js'
import { EditedMessage } from 'telegram/events/EditedMessage.js'
import { DeletedMessage } from 'telegram/events/DeletedMessage.js'
import { TG_PID_PATH } from './paths.js'
import { readCredentials, createClient, connectAuthorized, hasSession } from './client.js'
import { handleNewMessage, handleEditedMessage, handleDeletedMessages, syncUnread, catchUp, stats } from './log.js'
import { startMcpSocket, type McpSocketHandle } from './mcp.js'
import { getThrottleStats } from './throttle.js'
import { getTgDb, closeTgDb, setOwnerId, countForeignRows } from './db.js'

/**
 * Dialog refresh interval.
 *
 * Each pass is one getDialogs call. Unread counts also arrive via updates, so
 * this is a reconciliation pass, not the primary source — 15 minutes keeps the
 * daily call count negligible.
 */
const UNREAD_SYNC_MS = 15 * 60 * 1000

let client: TelegramClient | null = null
let mcp: McpSocketHandle | null = null
let unreadTimer: ReturnType<typeof setInterval> | null = null

function log(msg: string, extra?: unknown): void {
  const ts = new Date().toISOString()
  if (extra !== undefined) console.log(`[${ts}] ${msg}`, extra)
  else console.log(`[${ts}] ${msg}`)
}

function writePid(): void {
  writeFileSync(TG_PID_PATH, String(process.pid), 'utf-8')
}

function clearPid(): void {
  try {
    if (existsSync(TG_PID_PATH) && readFileSync(TG_PID_PATH, 'utf-8').trim() === String(process.pid)) {
      unlinkSync(TG_PID_PATH)
    }
  } catch { /* ignore */ }
}

/**
 * Raw update counter.
 *
 * Without it, "no messages logged" is ambiguous: it could mean updates never
 * arrive, or that they arrive and the policy drops them. This separates the two.
 * The first updates are logged with their type; after that only the count.
 */
let rawUpdates = 0
const RAW_VERBOSE_LIMIT = 30

async function attachHandlers(c: TelegramClient): Promise<void> {
  c.addEventHandler((update: { className?: string }) => {
    rawUpdates++
    if (rawUpdates <= RAW_VERBOSE_LIMIT) {
      log(`raw update #${rawUpdates}: ${update?.className ?? 'unknown'}`)
    }
  }, new Raw({}))

  // NewMessage with neither `incoming` nor `outgoing` set catches both directions.
  // Outgoing messages are the point: they carry Ivan's own commitments.
  c.addEventHandler((event: { message: Api.Message }) => {
    void handleNewMessage(event.message).catch(err => log('handleNewMessage failed', err))
  }, new NewMessage({}))

  c.addEventHandler((event: { message: Api.Message }) => {
    void handleEditedMessage(event.message).catch(err => log('handleEditedMessage failed', err))
  }, new EditedMessage({}))

  c.addEventHandler((event: { deletedIds?: number[] }) => {
    try {
      handleDeletedMessages(event.deletedIds ?? [])
    } catch (err) {
      log('handleDeletedMessages failed', err)
    }
  }, new DeletedMessage({}))
}

async function shutdown(signal: string): Promise<void> {
  log(`Отримано ${signal}, зупиняюсь...`)
  if (unreadTimer) clearInterval(unreadTimer)
  if (mcp) await mcp.close().catch(() => {})
  if (client) {
    try { await client.disconnect() } catch { /* ignore */ }
    try { await client.destroy() } catch { /* ignore */ }
  }
  closeTgDb()
  clearPid()
  process.exit(0)
}

async function main(): Promise<void> {
  writePid()
  getTgDb() // create schema before anything can write

  const creds = readCredentials()
  if (!creds) {
    log('TELEGRAM_API_ID / TELEGRAM_API_HASH не задані — демон не стартує.')
    log('Отримай їх на https://my.telegram.org → API development tools, і додай у .env проєкту.')
    clearPid()
    process.exit(1)
  }

  if (!hasSession()) {
    log('Немає збереженої сесії. Авторизуйся в адмінці: Telegram → Підключення.')
    log('MCP-сокет запускаю, але живі дії будуть недоступні до авторизації.')
    mcp = startMcpSocket(() => client)
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    return
  }

  client = createClient(creds)
  const authorized = await connectAuthorized(client)
  if (!authorized) {
    log('Сесія недійсна (відкликана або застаріла). Потрібна повторна авторизація в адмінці.')
    client = null
  } else {
    const me = await client.getMe()
    const name = (me as Api.User).username ?? (me as Api.User).firstName ?? 'невідомо'
    const ownerId = String((me as Api.User).id)
    log(`Підключено як ${name} (id ${ownerId})`)

    // Stamp the session owner before any write. `direction` is owner-relative:
    // the same chat_id logged from another account means the opposite thing,
    // and merging the two silently would corrupt the archive.
    const owner = setOwnerId(ownerId)
    if (owner.changed) {
      log(`Увага: акаунт змінився (був ${owner.previous}). Дані попереднього акаунта лишаються в базі, але приховані.`)
    }
    const foreign = countForeignRows()
    if (foreign.messages > 0 || foreign.chats > 0) {
      log(`У базі ${foreign.messages} повідомлень і ${foreign.chats} чатів іншого акаунта — вони не показуються і не використовуються.`)
    }

    await attachHandlers(client)
    await syncUnread(client).catch(err => log('syncUnread failed', err))

    // Updates only reach a live connection, so fill the gap left by downtime
    // before settling into realtime. Runs in the background: a slow catch-up
    // must not delay the MCP socket that bots are waiting on.
    void catchUp(client, msg => log(`catch-up: ${msg}`))
      .then(r => log(`Catch-up завершено: ${r.stored} повідомлень у ${r.chats} чатах${r.floodWaits ? `, FloodWait: ${r.floodWaits}` : ''}`))
      .catch(err => log('catchUp failed', err))
    unreadTimer = setInterval(() => {
      if (client) void syncUnread(client).catch(err => log('syncUnread failed', err))
    }, UNREAD_SYNC_MS)
  }

  mcp = startMcpSocket(() => client)
  log('MCP-сокет слухає')

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  process.on('unhandledRejection', (err) => log('unhandledRejection', err))

  // Heartbeat so the log shows the daemon is alive and how much it has seen.
  setInterval(() => {
    const t = getThrottleStats()
    const flood = t.floodUntil ? `, пауза до ${new Date(t.floodUntil).toISOString().slice(11, 19)}` : ''
    log(`Живий. Апдейтів: ${rawUpdates}. Повідомлень: бачено ${stats.seen}, збережено ${stats.stored}, пропущено ${stats.skipped}. `
      + `Запитів до Telegram сьогодні: ${t.calls}, FloodWait: ${t.floodWaits}${flood}. MCP-з'єднань: ${mcp?.connections() ?? 0}`)
  }, 15 * 60 * 1000)
}

main().catch((err) => {
  log('Фатальна помилка', err)
  clearPid()
  process.exit(1)
})
