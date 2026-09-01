/**
 * Telegram Observer — MCP server over a Unix socket.
 *
 * Transport choice: a TCP port on 127.0.0.1 is visible to every process the user
 * runs; a Unix socket is guarded by file permissions (0600) — the same mechanism
 * that already protects telegram.session. This mirrors the existing BotVa pattern
 * (mcp-servers/colleague talks to colleague.sock), except the far side here is a
 * real MCP server, so the shim is a pure pipe and tool schemas live only here.
 *
 * MCP over stdio is newline-delimited JSON-RPC, so the same framing travels over
 * the socket untranslated.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { existsSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { TelegramClient } from 'telegram'
import { TG_SOCK_PATH } from './paths.js'
import {
  listChats, countChats, listUnreadChats, getChat, getMessages, searchMessages,
  recordOutbox, countOutboxSince, setChatUnread,
} from './db.js'
import { listDialogs, getHistory, sendText, sendFile, resolveChat, markRead, getPeerState } from './client.js'

/** Outgoing action limits — a hard refusal, never a queue. */
const SEND_LIMIT_HOUR = 10
const SEND_LIMIT_DAY = 30

/** Minimal JSON-RPC transport over a duplex socket, mirroring StdioServerTransport. */
class SocketTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private buffer = ''

  constructor(private socket: Socket) {}

  async start(): Promise<void> {
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8')
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage)
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })
    this.socket.on('close', () => this.onclose?.())
    this.socket.on('error', (err) => this.onerror?.(err))
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.socket.destroyed) return
    this.socket.write(JSON.stringify(message) + '\n')
  }

  async close(): Promise<void> {
    this.socket.end()
  }
}

type TextResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (text: string): TextResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): TextResult => ({ content: [{ type: 'text', text }], isError: true })

function formatChatLine(c: { chat_id: string; title: string; username: string | null; kind: string; unread: number; mode: string }): string {
  const handle = c.username ? ` @${c.username}` : ''
  const unread = c.unread > 0 ? ` — ${c.unread} непрочитаних` : ''
  return `${c.title}${handle} [${c.kind}] (${c.chat_id}, режим: ${c.mode})${unread}`
}

function formatMessages(rows: { direction: string; sender_name: string | null; text: string; media_type: string | null; ts: number; msg_id: number }[]): string {
  if (rows.length === 0) return 'Порожньо.'
  return rows.map(m => {
    const when = new Date(m.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
    const who = m.direction === 'out' ? 'Я' : (m.sender_name || 'невідомо')
    const media = m.media_type ? ` [${m.media_type}]` : ''
    return `[${when}] #${m.msg_id} ${who}:${media} ${m.text}`
  }).join('\n')
}

const TOOLS = [
  {
    name: 'tg_list_chats',
    description: 'Список Telegram-чатів акаунта власника: назва, тип, кількість непрочитаних, режим логування. Відсортовано за свіжістю. Акаунт може мати тисячі чатів — звужуй пошуком search, а не великим limit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Фільтр за назвою, @username або chat_id' },
        active_days: { type: 'number', description: 'Тільки чати з активністю за останні N днів' },
        live: { type: 'boolean', description: 'true — тягнути свіжий список з Telegram; false (типово) — з локального реєстру' },
        limit: { type: 'number', description: 'Скільки чатів повернути (типово 30, максимум 100)' },
        offset: { type: 'number', description: 'Зсув для гортання' },
      },
    },
  },
  {
    name: 'tg_unread',
    description: 'Чати з непрочитаними повідомленнями. Використовуй на запит "що нового", "які непрочитані", "хто мені писав".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        live: { type: 'boolean', description: 'true — оновити лічильники з Telegram перед відповіддю' },
        limit: { type: 'number', description: 'Скільки чатів повернути (типово 20)' },
      },
    },
  },
  {
    name: 'tg_read_chat',
    description: 'Прочитати останні повідомлення конкретного чату. За замовчуванням з живого Telegram; from_log=true читає локальний архів.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat: { type: 'string', description: 'chat_id, @username або назва чату' },
        limit: { type: 'number', description: 'Скільки повідомлень (типово 30, максимум 200)' },
        from_log: { type: 'boolean', description: 'true — з локального логу замість живого запиту' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'tg_search',
    description: 'Пошук по локальному архіву переписки (дослівні цитати). НЕ для пошуку фактів у пам\'яті — для цього SearchMemory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Пошуковий запит' },
        chat: { type: 'string', description: 'Обмежити конкретним chat_id' },
        limit: { type: 'number', description: 'Скільки результатів (типово 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'tg_resolve',
    description: 'Знайти chat_id за @username, номером або назвою. Використовуй перед tg_send_message якщо маєш лише ім\'я.',
    inputSchema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: '@username, номер телефону або назва' } },
      required: ['query'],
    },
  },
  {
    name: 'tg_send_message',
    description: 'Надіслати повідомлення від імені власника акаунта. 🔒 ОБОВ\'ЯЗКОВО спершу показати текст користувачу і отримати підтвердження через AskUser. Чат має бути дозволений для відправки в адмінці. Перед відправкою чат автоматично позначається прочитаним — людина спершу читає, потім відповідає.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat: { type: 'string', description: 'chat_id або @username' },
        text: { type: 'string', description: 'Текст повідомлення' },
        mark_read: { type: 'boolean', description: 'Позначити чат прочитаним перед відправкою (типово true). false — лише якщо свідомо треба відповісти, лишивши решту непрочитаною' },
      },
      required: ['chat', 'text'],
    },
  },
  {
    name: 'tg_send_file',
    description: 'Надіслати файл або фото від імені власника. 🔒 Тільки після підтвердження через AskUser. Чат має бути дозволений для відправки.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat: { type: 'string', description: 'chat_id або @username' },
        path: { type: 'string', description: 'Абсолютний шлях до файлу' },
        caption: { type: 'string', description: 'Підпис (опційно)' },
        as_document: { type: 'boolean', description: 'true — надіслати як документ без стиснення' },
        mark_read: { type: 'boolean', description: 'Позначити чат прочитаним перед відправкою (типово true)' },
      },
      required: ['chat', 'path'],
    },
  },
  {
    name: 'tg_mark_read',
    description: 'Позначити чат прочитаним.',
    inputSchema: {
      type: 'object' as const,
      properties: { chat: { type: 'string', description: 'chat_id або @username' } },
      required: ['chat'],
    },
  },
  {
    name: 'tg_chat_state',
    description: 'Живий стан чату з Telegram: скільки непрочитаних і до якого повідомлення власник дочитав. Питай перед тим, як писати від імені власника — локальний лічильник не бачить, що чат відкрили з телефона.',
    inputSchema: {
      type: 'object' as const,
      properties: { chat: { type: 'string', description: 'chat_id або @username' } },
      required: ['chat'],
    },
  },
]

/**
 * Resolve a user-supplied chat reference to a registered chat row.
 * Sending requires a chat that exists in the registry AND is allowlisted.
 */
function requireSendableChat(chat: string): { chat_id: string } | { error: string } {
  const row = getChat(chat)
  if (!row) {
    return { error: `Чат "${chat}" не знайдено в реєстрі. Спершу tg_resolve, потім увімкни відправку в адмінці (Telegram → Чати).` }
  }
  if (!row.can_send) {
    return { error: `Відправка в "${row.title}" не дозволена. Увімкни її в адмінці: Telegram → Чати → ${row.title} → дозволити відправку.` }
  }
  return { chat_id: row.chat_id }
}

/**
 * Mark the chat read before answering it.
 *
 * The other side sees read receipts. Replying while their messages stay unread
 * reads as unnatural and gives the automation away — a person reads, then
 * answers. Failure here must not block the send, so it is reported, not thrown.
 */
async function markReadBeforeSend(
  client: TelegramClient,
  chatId: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (args['mark_read'] === false) return
  try {
    await markRead(client, chatId)
    setChatUnread(chatId, 0)
  } catch { /* read receipts are cosmetic; the message still goes out */ }
}

function checkSendLimits(): string | null {
  const nowTs = Math.floor(Date.now() / 1000)
  if (countOutboxSince(nowTs - 3600) >= SEND_LIMIT_HOUR) {
    return `Ліміт вихідних вичерпано: ${SEND_LIMIT_HOUR} на годину.`
  }
  if (countOutboxSince(nowTs - 86400) >= SEND_LIMIT_DAY) {
    return `Ліміт вихідних вичерпано: ${SEND_LIMIT_DAY} на добу.`
  }
  return null
}

async function callTool(
  client: TelegramClient | null,
  name: string,
  args: Record<string, unknown>,
  caller: string,
): Promise<TextResult> {
  const needsLive = (): TelegramClient | null => client

  switch (name) {
    case 'tg_list_chats': {
      const limit = Math.min(Number(args['limit'] ?? 30), 100)
      if (args['live']) {
        const live = needsLive()
        if (!live) return fail('Telegram не підключений — живий список недоступний.')
        const dialogs = await listDialogs(live, limit)
        return ok(dialogs.map(d => formatChatLine({ ...d, mode: getChat(d.chat_id)?.mode ?? 'невідомо' })).join('\n') || 'Порожньо.')
      }

      const activeDays = Number(args['active_days'] ?? 0) || 0
      const filter = {
        search: args['search'] ? String(args['search']) : undefined,
        activeSince: activeDays > 0 ? Math.floor(Date.now() / 1000) - activeDays * 86400 : undefined,
        limit,
        offset: Math.max(0, Number(args['offset'] ?? 0) || 0),
      }
      const chats = listChats(filter)
      if (chats.length === 0) {
        return ok(filter.search
          ? `Чатів за запитом "${filter.search}" не знайдено.`
          : 'Реєстр порожній — чати з\'являться після запуску демона.')
      }

      const total = countChats(filter)
      const shown = filter.offset + chats.length
      const more = total > shown ? `\n\n(показано ${shown} з ${total} — використай offset щоб гортати далі)` : ''
      return ok(chats.map(formatChatLine).join('\n') + more)
    }

    case 'tg_unread': {
      const limit = Math.min(Number(args['limit'] ?? 20), 100)
      if (args['live']) {
        const live = needsLive()
        if (!live) return fail('Telegram не підключений.')
        const dialogs = await listDialogs(live, 100)
        for (const d of dialogs) setChatUnread(d.chat_id, d.unread)
      }
      const rows = listUnreadChats(limit)
      if (rows.length === 0) return ok('Непрочитаних немає.')
      return ok(rows.map(formatChatLine).join('\n'))
    }

    case 'tg_read_chat': {
      const chat = String(args['chat'] ?? '')
      const limit = Math.min(Number(args['limit'] ?? 30), 200)
      if (!chat) return fail('Потрібен параметр chat')

      if (args['from_log']) {
        const rows = getMessages(chat, limit).reverse()
        return ok(formatMessages(rows))
      }
      const live = needsLive()
      if (!live) return fail('Telegram не підключений — читай з логу: from_log=true')
      try {
        const history = await getHistory(live, chat, limit)
        return ok(formatMessages(history.map(h => ({ ...h, sender_name: h.sender_name }))))
      } catch (err) {
        return fail(`Не вдалось прочитати чат: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    case 'tg_search': {
      const query = String(args['query'] ?? '')
      if (!query) return fail('Потрібен параметр query')
      const rows = searchMessages(query, {
        chatId: args['chat'] ? String(args['chat']) : undefined,
        limit: Math.min(Number(args['limit'] ?? 30), 100),
      })
      if (rows.length === 0) return ok('Нічого не знайдено в архіві.')
      return ok(rows.map(m => {
        const chat = getChat(m.chat_id)
        return `${chat?.title ?? m.chat_id}: ${formatMessages([m])}`
      }).join('\n'))
    }

    case 'tg_resolve': {
      const query = String(args['query'] ?? '')
      if (!query) return fail('Потрібен параметр query')
      const live = needsLive()
      if (!live) return fail('Telegram не підключений.')
      const info = await resolveChat(live, query)
      if (!info) return ok(`Не знайдено: ${query}`)
      const row = getChat(info.chat_id)
      return ok(`${info.title} [${info.kind}] chat_id=${info.chat_id}${info.username ? ` @${info.username}` : ''}\nВідправка: ${row?.can_send ? 'дозволена' : 'не дозволена'}`)
    }

    case 'tg_send_message': {
      const text = String(args['text'] ?? '')
      if (!text.trim()) return fail('Порожній текст')
      const target = requireSendableChat(String(args['chat'] ?? ''))
      if ('error' in target) return fail(target.error)
      const limitError = checkSendLimits()
      if (limitError) return fail(limitError)

      const live = needsLive()
      if (!live) return fail('Telegram не підключений — відправка неможлива.')
      try {
        await markReadBeforeSend(live, target.chat_id, args)
        const msgId = await sendText(live, target.chat_id, text)
        recordOutbox({ chat_id: target.chat_id, kind: 'message', text, status: 'sent', requested_by: caller, msg_id: msgId })
        return ok(`Надіслано (msg_id ${msgId}).`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        recordOutbox({ chat_id: target.chat_id, kind: 'message', text, status: 'failed', error: msg, requested_by: caller })
        return fail(`Не вдалось надіслати: ${msg}`)
      }
    }

    case 'tg_send_file': {
      const path = String(args['path'] ?? '')
      if (!path) return fail('Потрібен параметр path')
      const target = requireSendableChat(String(args['chat'] ?? ''))
      if ('error' in target) return fail(target.error)
      const limitError = checkSendLimits()
      if (limitError) return fail(limitError)

      const live = needsLive()
      if (!live) return fail('Telegram не підключений — відправка неможлива.')
      const caption = args['caption'] ? String(args['caption']) : undefined
      try {
        await markReadBeforeSend(live, target.chat_id, args)
        const msgId = await sendFile(live, target.chat_id, path, caption, Boolean(args['as_document']))
        recordOutbox({ chat_id: target.chat_id, kind: 'file', text: caption ?? '', file_path: path, status: 'sent', requested_by: caller, msg_id: msgId })
        return ok(`Файл надіслано (msg_id ${msgId}).`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        recordOutbox({ chat_id: target.chat_id, kind: 'file', text: caption ?? '', file_path: path, status: 'failed', error: msg, requested_by: caller })
        return fail(`Не вдалось надіслати файл: ${msg}`)
      }
    }

    case 'tg_mark_read': {
      const chat = String(args['chat'] ?? '')
      if (!chat) return fail('Потрібен параметр chat')
      const live = needsLive()
      if (!live) return fail('Telegram не підключений.')
      await markRead(live, chat)
      setChatUnread(chat, 0)
      return ok('Позначено прочитаним.')
    }

    case 'tg_chat_state': {
      const chat = String(args['chat'] ?? '')
      if (!chat) return fail('Потрібен параметр chat')
      const live = needsLive()
      if (!live) return fail('Telegram не підключений.')
      const state = await getPeerState(live, chat)
      if (!state) return fail(`Не вдалось прочитати стан чату "${chat}".`)
      // Keep the local counter honest while we have the truth in hand.
      setChatUnread(state.chat_id, state.unread)
      return ok(JSON.stringify(state))
    }

    default:
      return fail(`Невідомий інструмент: ${name}`)
  }
}

/** Build a fresh MCP server bound to one client connection. */
function buildServer(getClient: () => TelegramClient | null): Server {
  const server = new Server(
    { name: 'telegram-observer', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const caller = String((args as Record<string, unknown> | undefined)?.['_caller'] ?? 'bot')
    try {
      return await callTool(getClient(), name, (args ?? {}) as Record<string, unknown>, caller)
    } catch (err) {
      return fail(`Помилка ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  return server
}

export interface McpSocketHandle {
  close: () => Promise<void>
  connections: () => number
}

/**
 * Listen on the Unix socket. Each connection gets its own MCP Server instance,
 * so several bots can talk to the daemon in parallel.
 */
export function startMcpSocket(getClient: () => TelegramClient | null): McpSocketHandle {
  mkdirSync(dirname(TG_SOCK_PATH), { recursive: true })
  if (existsSync(TG_SOCK_PATH)) {
    try { unlinkSync(TG_SOCK_PATH) } catch { /* stale socket from a hard kill */ }
  }

  let active = 0

  const netServer: NetServer = createServer((socket) => {
    active++
    socket.on('close', () => { active-- })

    const server = buildServer(getClient)
    const transport = new SocketTransport(socket)
    server.connect(transport).catch(() => { socket.destroy() })
  })

  netServer.listen(TG_SOCK_PATH, () => {
    try { chmodSync(TG_SOCK_PATH, 0o600) } catch { /* best effort */ }
  })

  return {
    close: () => new Promise<void>((resolve) => {
      netServer.close(() => {
        if (existsSync(TG_SOCK_PATH)) {
          try { unlinkSync(TG_SOCK_PATH) } catch { /* ignore */ }
        }
        resolve()
      })
    }),
    connections: () => active,
  }
}
