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
import { readCredentials, createClient, connectAuthorized, hasSession, RESILIENT_CONNECTION } from './client.js'
import { handleNewMessage, handleEditedMessage, handleDeletedMessages, syncUnread, catchUp, stats } from './log.js'
import { startMcpSocket, type McpSocketHandle } from './mcp.js'
import {
  getThrottleStats, topLabels, countUnpacedCall, configureThrottlePersistence,
} from './throttle.js'
import { watchdogAction, nextFailureCount } from './watchdog.js'
import {
  getTgDb, closeTgDb, setOwnerId, setOwnerUsername, countForeignRows,
  noteApiCall, getApiCalls, pruneApiCalls,
} from './db.js'

/**
 * Dialog refresh interval.
 *
 * Each pass is one getDialogs call. Unread counts also arrive via updates, so
 * this is a reconciliation pass, not the primary source — 15 minutes keeps the
 * daily call count negligible.
 */
const UNREAD_SYNC_MS = 15 * 60 * 1000

/**
 * Watchdog tick.
 *
 * Every tick compares the raw update counter with the previous one; the health
 * line is printed every third tick, so the log keeps its old 15-minute rhythm
 * while a stall is caught within five minutes.
 */
const WATCHDOG_MS = 5 * 60 * 1000
const HEARTBEAT_EVERY_TICKS = 3

/** A probe that hangs is a probe that failed — the socket is what we doubt. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Consecutive failed probes before the daemon gives up and exits non-zero.
 *
 * Two ticks is ten minutes of confirmed silence, with one forced reconnect
 * attempted in between. Exiting is not a defeat: launchd restarts us, and a
 * fresh process reconnects and runs catch-up, which is exactly the recovery
 * a stuck update loop needs.
 */
const STALL_EXITS_AFTER = 2

let client: TelegramClient | null = null
let mcp: McpSocketHandle | null = null
let unreadTimer: ReturnType<typeof setInterval> | null = null
let watchdogTimer: ReturnType<typeof setInterval> | null = null

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

async function releaseResources(): Promise<void> {
  if (unreadTimer) clearInterval(unreadTimer)
  if (watchdogTimer) clearInterval(watchdogTimer)
  if (mcp) await mcp.close().catch(() => {})
  if (client) {
    try { await client.disconnect() } catch { /* ignore */ }
    try { await client.destroy() } catch { /* ignore */ }
  }
  closeTgDb()
  clearPid()
}

async function shutdown(signal: string): Promise<void> {
  log(`Отримано ${signal}, зупиняюсь...`)
  await releaseResources()
  // A clean exit tells launchd this was intentional: KeepAlive/SuccessfulExit
  // leaves us down, which is what `telegram-observer.sh stop` means.
  process.exit(0)
}

/**
 * Exit with a failure code so the supervisor brings us back.
 *
 * The opposite contract to shutdown(): the daemon is not done, it is stuck,
 * and only a fresh process can fix that.
 */
async function exitForRestart(reason: string): Promise<void> {
  log(`ПЕРЕЗАПУСК: ${reason}`)
  await releaseResources()
  process.exit(1)
}

/**
 * Ask Telegram directly whether the connection still carries traffic.
 *
 * A stalled counter is a strong hint but not proof — an account can genuinely
 * go quiet — so nothing is done on the hint alone.
 */
async function connectionAlive(c: TelegramClient): Promise<boolean> {
  if (!c.connected) return false
  let timer: ReturnType<typeof setTimeout> | null = null
  const expired = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS)
  })
  // Not paced and never refused — see countUnpacedCall. Counted because it is
  // still a real request to Telegram, and a budget that omits some calls tells
  // us less than it claims.
  countUnpacedCall('watchdog.getMe')
  try {
    return await Promise.race([c.getMe().then(() => true, () => false), expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  writePid()
  getTgDb() // create schema before anything can write

  // The day's call tally lives in the database, not in this process, so a
  // restart resumes the count instead of starting it over.
  configureThrottlePersistence({ note: noteApiCall, load: getApiCalls })
  pruneApiCalls()

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

  client = createClient(creds, undefined, RESILIENT_CONNECTION)
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
    // The handle is how a mention is recognised in a group: the log keeps no
    // message entities, so "@name" in the text is the signal. Without a handle
    // only replies to the owner's own messages can count.
    const username = (me as Api.User).username
    if (username) setOwnerUsername(username)
    else log('У акаунта немає @username — у групах спрацьовуватимуть лише відповіді на твої повідомлення.')

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

  watchdogTimer = setInterval(() => { void watchdogTick() }, WATCHDOG_MS)
}

/** Counters as of the previous tick, and how many probes have failed in a row. */
let lastSeenUpdates = -1
let failedProbes = 0
let tick = 0

function healthLine(): string {
  const t = getThrottleStats()
  const flood = t.floodUntil ? `, пауза до ${new Date(t.floodUntil).toISOString().slice(11, 19)}` : ''
  // Who spent the calls, not just how many: a bare total says whether we are
  // near the ceiling and nothing about what to look at if we are.
  const top = topLabels(t)
  return `Апдейтів: ${rawUpdates}. Повідомлень: бачено ${stats.seen}, збережено ${stats.stored}, пропущено ${stats.skipped}. `
    + `Запитів до Telegram сьогодні: ${t.calls}${top ? ` (${top})` : ''}, FloodWait: ${t.floodWaits}${flood}. `
    + `MCP-з'єднань: ${mcp?.connections() ?? 0}`
}

/**
 * Liveness, not just presence.
 *
 * The old heartbeat printed "Живий" whenever the process existed, which is a
 * different claim from the one that matters. `UpdateUserStatus` alone keeps the
 * counter moving roughly once a second, so a tick that sees no new updates is
 * worth checking — and if the check fails twice, being restarted beats being
 * silently blind.
 */
async function watchdogTick(): Promise<void> {
  tick++
  const moved = rawUpdates !== lastSeenUpdates
  lastSeenUpdates = rawUpdates
  const due = tick % HEARTBEAT_EVERY_TICKS === 0

  // No client means no session yet — a stall is expected, not a fault.
  if (!client) {
    if (due) log(`Живий. ${healthLine()}`)
    return
  }

  // The probe costs one API call and only fires when the counter stood still.
  const alive = moved ? true : await connectionAlive(client)
  if (!alive) failedProbes++
  const action = watchdogAction({ moved, alive, failedProbes, exitsAfter: STALL_EXITS_AFTER })
  failedProbes = nextFailureCount(failedProbes, action)

  switch (action) {
    case 'healthy':
      if (due) log(`Живий. ${healthLine()}`)
      return
    case 'quiet':
      log(`Тиша: жодного апдейту за ${WATCHDOG_MS / 60000} хв, але зв'язок відповідає. ${healthLine()}`)
      return
    case 'reconnect':
      log(`УВАГА: Telegram не відповідає (невдала перевірка ${failedProbes}/${STALL_EXITS_AFTER}). ${healthLine()}`)
      // One forced reconnect before giving up — cheaper than a full restart,
      // and enough when GramJS lost its way rather than the network.
      try {
        await client.connect()
        log('Перепідключення виконано, чекаю апдейтів.')
      } catch (err) {
        log('Перепідключення не вдалося', err)
      }
      return
    case 'restart':
      log(`УВАГА: Telegram не відповідає (невдала перевірка ${failedProbes}/${STALL_EXITS_AFTER}). ${healthLine()}`)
      await exitForRestart(`зв'язок мертвий ${(STALL_EXITS_AFTER * WATCHDOG_MS) / 60000} хв`)
      return
  }
}

main().catch((err) => {
  log('Фатальна помилка', err)
  clearPid()
  process.exit(1)
})
