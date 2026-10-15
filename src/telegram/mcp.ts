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
  recordOutbox, countOutboxSince, setChatUnread, insertMessage,
  syncChatMembers, listChatMembers, chatMembersSyncedAt, listPeople, getPerson,
  setPersonProfile, personName, type TgPerson,
} from './db.js'
import {
  listDialogs, getHistory, getOwnHistory, sendText, sendFile, resolveChat, markRead,
  getPeerState, getParticipants, readContactNote, writeContactNote, addContact,
  sendContact, sendVcardFile, importContactByPhone,
  MAX_HISTORY, MAX_PARTICIPANTS,
} from './client.js'

import { checkSendLimits } from './send-policy.js'

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

/**
 * One person as a line a model can read.
 *
 * The canonical name comes first because that is the one the owner chose; the
 * Telegram display name is only shown when it differs, since a mismatch is
 * exactly what makes a person hard to recognise later.
 */
function formatPersonLine(p: TgPerson & { status?: string }): string {
  const parts = [personName(p)]
  if (p.canonical_name && p.display_name && p.canonical_name !== p.display_name) {
    parts.push(`(у Telegram: ${p.display_name})`)
  }
  if (p.username) parts.push(`@${p.username}`)
  if (p.role) parts.push(`— ${p.role}`)
  if (p.is_bot) parts.push('[бот]')
  const seen = p.seen_last ? new Date(p.seen_last * 1000).toLocaleDateString('uk-UA') : null
  const tail: string[] = []
  if (p.msg_count > 0) tail.push(`${p.msg_count} повідомл.`)
  if (seen) tail.push(`останнє ${seen}`)
  if (p.note) tail.push(p.note)
  return `#${p.peer_id} ${parts.join(' ')}${tail.length ? ` · ${tail.join(', ')}` : ''}`
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
    name: 'tg_my_messages',
    description: 'Тільки повідомлення власника в цьому чаті, без чужих. Корисно в групах, щоб побачити його власну манеру чи згадати, що саме він там писав — фільтрація на боці Telegram, не вичитування всієї історії.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat: { type: 'string', description: 'chat_id або @username' },
        limit: { type: 'number', description: 'скільки повідомлень (за замовчуванням 30, максимум 100)' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'tg_seed_chat',
    description: 'Наповнити локальний архів чату: підтягнути свіжу історію і окремо всі повідомлення власника в цьому чаті, зберегти в лог. Разова підготовча дія для щойно доданого чату — повторний виклик нічого не дублює. Повертає JSON зі stored і newest_msg_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat: { type: 'string', description: 'chat_id (чат має бути в реєстрі)' },
        limit: { type: 'number', description: 'скільки останніх повідомлень підтягнути (типово 100, максимум 100)' },
        own_limit: { type: 'number', description: 'скільки власних повідомлень підтягнути (типово 50, максимум 100)' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'tg_chat_members',
    description: 'Хто складається в групі чи супергрупі — саме учасники, а не ті, хто писав. Мовчазного учасника в логу не видно, а той, хто давно вийшов, у логу лишається назавжди. За замовчуванням віддає збережений склад; refresh=true тягне свіжий з Telegram і оновлює довідник людей. Для великих груп Telegram віддає неповний список — це нормальна відповідь, у ній буде сказано скільки з якої кількості видно.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat: { type: 'string', description: 'chat_id, @username або назва групи' },
        refresh: { type: 'boolean', description: 'true — запитати склад у Telegram (типово false: віддати збережений)' },
        search: { type: 'string', description: 'Фільтр за іменем чи @username' },
        limit: { type: 'number', description: `Скільки учасників (типово 200, максимум ${MAX_PARTICIPANTS})` },
      },
      required: ['chat'],
    },
  },
  {
    name: 'tg_people',
    description: 'Довідник людей: канонічне ім\'я, роль, @username, скільки писали, коли востаннє. Наповнюється сам із логу. Питай коли треба зрозуміти, хто така людина, або знайти когось за роллю чи іменем. Без аргументів — найактивніші за останнім контактом.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Ім\'я, @username або алаяс' },
        chat: { type: 'string', description: 'Тільки люди з цього чату' },
        with_role_only: { type: 'boolean', description: 'Тільки ті, кому проставлено роль' },
        include_bots: { type: 'boolean', description: 'Включати ботів (типово ні)' },
        limit: { type: 'number', description: 'Скільки людей (типово 50, максимум 500)' },
      },
    },
  },
  {
    name: 'tg_name_person',
    description: 'Записати, хто ця людина: канонічне ім\'я, роль (дружина, підрядник, замовник), алаяси, нотатка. Канонічне ім\'я витісняє те, як людина підписана в Telegram — саме воно йде далі в аналіз і у факти. Передавай лише ті поля, які змінюєш.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        peer_id: { type: 'string', description: 'id людини з tg_people' },
        canonical_name: { type: 'string', description: 'Як звати цю людину насправді' },
        role: { type: 'string', description: 'Ким вона є власнику: дружина, підрядник, замовник, колега' },
        aliases: { type: 'string', description: 'Інші імена через кому — щоб знаходилась пошуком' },
        note: { type: 'string', description: 'Коротка нотатка' },
      },
      required: ['peer_id'],
    },
  },
  {
    name: 'tg_contact_note',
    description: 'Профіль людини в Telegram: нотатка, яку Telegram показує власнику біля контакту («Add notes only visible to you»), чи людина взагалі в контактах, і шлях до її аватара на диску. Аватар качається один раз і кешується — у відповіді шлях до файлу, не саме зображення. Це не наша нотатка з tg_people — для неї є tg_people і tg_name_person.',
    inputSchema: {
      type: 'object' as const,
      properties: { peer: { type: 'string', description: 'peer_id або @username' } },
      required: ['peer'],
    },
  },
  {
    name: 'tg_write_note',
    description: 'Записати нотатку в сам профіль контакту в Telegram — вона з\'явиться в клієнтах власника біля цієї людини. Порожній текст стирає нотатку. Працює лише для тих, хто вже в контактах: якщо ні, спершу tg_add_contact. Записує тільки нотатку, імені не чіпає.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        peer: { type: 'string', description: 'peer_id або @username' },
        note: { type: 'string', description: 'Текст нотатки; порожній рядок — стерти' },
        sync_local: { type: 'boolean', description: 'Записати той самий текст і в tg_people.note (типово так)' },
      },
      required: ['peer', 'note'],
    },
  },
  {
    name: 'tg_add_contact',
    description: 'Додати людину в контакти власника, одразу з іменем і (за бажанням) нотаткою. Ім\'я — це як власник її називає, воно витісняє її власний підпис у Telegram. Не додавай без прямої вказівки: це видима зміна в акаунті.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        peer: { type: 'string', description: 'peer_id або @username' },
        first_name: { type: 'string', description: 'Ім\'я, під яким власник хоче її бачити' },
        last_name: { type: 'string', description: 'Прізвище, якщо треба' },
        note: { type: 'string', description: 'Нотатка, видима лише власнику' },
        phone: { type: 'string', description: 'Номер телефону цієї людини, якщо він відомий. Контакт без номера не можна надіслати карткою' },
        share_phone: { type: 'boolean', description: 'Відкрити цій людині номер власника. Типово ні — це розкриття даних, а не зручність' },
      },
      required: ['peer', 'first_name'],
    },
  },
  {
    name: 'tg_import_contact',
    description: 'Додати людину в контакти ЗА НОМЕРОМ ТЕЛЕФОНУ — так, як це робить синхронізація адресної книги телефона. Єдиний спосіб отримати повноцінний контакт із номером: доданий за @ніком номера не має, а без номера його не можна надіслати карткою. Номер вивантажується в Telegram для пошуку збігу; якщо акаунта на ньому немає — просто нічого не знайдеться, повідомлення нікому не піде.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phone: { type: 'string', description: 'Номер у будь-якому вигляді: +380 73 123 45 67, 380731234567' },
        first_name: { type: 'string', description: 'Ім\'я, під яким власник хоче її бачити' },
        last_name: { type: 'string', description: 'Прізвище, якщо треба' },
        note: { type: 'string', description: 'Нотатка, видима лише власнику' },
      },
      required: ['phone', 'first_name'],
    },
  },
  {
    name: 'tg_send_contact',
    description: 'Надіслати комусь картку контакту іншої людини — від імені власника. Ім\'я на картці — те, як власник цю людину назвав. Працює тільки для тих, чий номер видно власнику: картки без номера в Telegram не існує, тож для решти надсилай дані текстом (ім\'я, @нік, пояснення). Приватна нотатка з профілю НЕ передається і передана бути не може: те, що має прочитати отримувач, пишеться в comment.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat: { type: 'string', description: 'Кому надіслати: chat_id або @username' },
        peer: { type: 'string', description: 'Чию картку: peer_id або @username' },
        comment: { type: 'string', description: 'Підпис під карткою, який ПРОЧИТАЄ ОТРИМУВАЧ. Не для приватних нотаток' },
        attach_note: { type: 'boolean', description: 'Вкласти той самий comment усередину картки (vCard), щоб він лишився в контакті, коли отримувач збереже його в телефон. Типово ні — картка йде без нотатки. Потребує comment' },
        as_file: { type: 'boolean', description: 'Надіслати не карткою, а файлом .vcf. Єдиний спосіб для людини, чий номер власнику не видно: у файл ідуть ім\'я, @нік як Telegram-профіль і посилання t.me, id та (з attach_note) коментар, і отримувач може імпортувати його в контакти телефона' },
        mark_read: { type: 'boolean', description: 'false — не позначати чат прочитаним перед відправкою' },
      },
      required: ['chat', 'peer'],
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

    case 'tg_my_messages': {
      const chat = String(args['chat'] ?? '')
      if (!chat) return fail('Потрібен параметр chat')
      const live = needsLive()
      if (!live) return fail('Telegram не підключений. Читання власних повідомлень потребує живої сесії.')
      const limit = Math.min(Number(args['limit'] ?? 30) || 30, MAX_HISTORY)
      const own = await getOwnHistory(live, chat, limit)
      if (own.length === 0) return ok('Власник у цьому чаті нічого не писав.')
      return ok(own.map(m => `[${new Date(m.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')}] ${m.text || `[${m.media_type ?? 'вкладення'}]`}`).join('\n'))
    }

    case 'tg_seed_chat': {
      const chat = String(args['chat'] ?? '')
      if (!chat) return fail('Потрібен параметр chat')
      const row = getChat(chat)
      if (!row) return fail(`Чат "${chat}" не знайдено в реєстрі.`)
      const live = needsLive()
      if (!live) return fail('Telegram не підключений.')

      const limit = Math.min(Number(args['limit'] ?? 100) || 100, MAX_HISTORY)
      const ownLimit = Math.min(Number(args['own_limit'] ?? 50) || 50, MAX_HISTORY)

      // Two calls, both bounded, both idempotent: the log's unique key drops
      // anything already stored, so re-seeding costs requests but not integrity.
      const recent = await getHistory(live, row.chat_id, limit)
      const own = await getOwnHistory(live, row.chat_id, ownLimit)

      let stored = 0
      let newest = 0
      for (const m of [...recent, ...own]) {
        if (!m.text && !m.media_type) continue
        if (m.msg_id > newest) newest = m.msg_id
        if (insertMessage({
          chat_id: row.chat_id,
          msg_id: m.msg_id,
          direction: m.direction,
          sender_id: m.sender_id,
          sender_name: m.sender_name,
          text: m.text,
          media_type: m.media_type,
          reply_to: m.reply_to,
          ts: m.ts,
        })) stored++
      }
      // The caller needs the high-water mark: back-filled history predates the
      // decision to switch the chat on, and must not read as unanswered.
      return ok(JSON.stringify({
        chat_id: row.chat_id,
        title: row.title,
        stored,
        newest_msg_id: newest,
        checked_recent: recent.length,
        checked_own: own.length,
      }))
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

    case 'tg_chat_members': {
      const row = getChat(String(args['chat'] ?? ''))
      if (!row) return fail(`Чат "${args['chat']}" не знайдено в реєстрі.`)
      if (row.kind === 'user' || row.kind === 'bot') {
        return fail(`"${row.title}" — приватний чат, у нього немає складу учасників.`)
      }
      if (row.mode === 'ignore') {
        return fail(`Чат "${row.title}" у режимі ignore — він свідомо поза системою.`)
      }

      const limit = Math.min(Number(args['limit'] ?? 200) || 200, MAX_PARTICIPANTS)
      const search = args['search'] ? String(args['search']) : undefined
      let note = ''

      if (args['refresh']) {
        const live = needsLive()
        if (!live) return fail('Telegram не підключений — свіжий склад недоступний.')
        try {
          const res = await getParticipants(live, row.chat_id, { limit, search })
          syncChatMembers(row.chat_id, res.members)
          if (res.truncated) {
            note = `\n\nВидно ${res.members.length} з ${res.total} — Telegram не дає перелічити решту цьому акаунту.`
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return fail(`Не вдалось прочитати склад "${row.title}": ${msg}`)
        }
      }

      const stored = listChatMembers(row.chat_id, limit)
      const filtered = search
        ? stored.filter(m => m.search_key.includes(search.toLowerCase()))
        : stored
      if (filtered.length === 0) {
        const syncedAt = chatMembersSyncedAt(row.chat_id)
        return ok(syncedAt === 0
          ? `Склад "${row.title}" ще не зчитували. Виклич ще раз із refresh=true.`
          : `У складі "${row.title}" нікого не знайдено${search ? ` за запитом "${search}"` : ''}.`)
      }

      const when = chatMembersSyncedAt(row.chat_id)
      const header = `${row.title} — ${filtered.length} учасників (зчитано ${when ? new Date(when * 1000).toLocaleString('uk-UA') : 'невідомо коли'})`
      return ok(`${header}\n${filtered.map(formatPersonLine).join('\n')}${note}`)
    }

    case 'tg_people': {
      const chatRef = args['chat'] ? String(args['chat']) : undefined
      const chatId = chatRef ? getChat(chatRef)?.chat_id : undefined
      if (chatRef && !chatId) return fail(`Чат "${chatRef}" не знайдено в реєстрі.`)

      const people = listPeople({
        search: args['search'] ? String(args['search']) : undefined,
        chatId,
        withRoleOnly: args['with_role_only'] === true,
        includeBots: args['include_bots'] === true,
        limit: Math.min(Number(args['limit'] ?? 50) || 50, 500),
      })
      if (people.length === 0) return ok('Нікого не знайдено.')
      return ok(people.map(formatPersonLine).join('\n'))
    }

    case 'tg_name_person': {
      const peerId = String(args['peer_id'] ?? '')
      if (!peerId) return fail('Потрібен параметр peer_id')
      if (!getPerson(peerId)) return fail(`Людину ${peerId} не знайдено в довіднику.`)
      setPersonProfile(peerId, {
        canonical_name: args['canonical_name'] !== undefined ? String(args['canonical_name']) : undefined,
        role: args['role'] !== undefined ? String(args['role']) : undefined,
        aliases: args['aliases'] !== undefined ? String(args['aliases']) : undefined,
        note: args['note'] !== undefined ? String(args['note']) : undefined,
      })
      const updated = getPerson(peerId)
      return ok(updated ? `Записано: ${formatPersonLine(updated)}` : 'Записано.')
    }

    case 'tg_send_contact': {
      const peer = String(args['peer'] ?? '')
      if (!peer) return fail('Потрібен параметр peer — чию картку надсилати')
      const target = requireSendableChat(String(args['chat'] ?? ''))
      if ('error' in target) return fail(target.error)
      const limitError = checkSendLimits()
      if (limitError) return fail(limitError)

      const live = needsLive()
      if (!live) return fail('Telegram не підключений — відправка неможлива.')

      const comment = args['comment'] !== undefined ? String(args['comment']) : ''
      const attachNote = args['attach_note'] === true
      const asFile = args['as_file'] === true
      if (attachNote && !comment.trim()) {
        return fail('attach_note без comment — нема чого вкладати в картку. Напиши текст у comment.')
      }

      try {
        await markReadBeforeSend(live, target.chat_id, args)
        const send = asFile ? sendVcardFile : sendContact
        const sent = await send(live, target.chat_id, peer, { comment, attachNote })
        // The outbox records what left the account, and a contact card is a
        // disclosure about a third person — it belongs in the journal by name.
        recordOutbox({
          chat_id: target.chat_id, kind: 'contact',
          text: `${asFile ? 'vcf' : 'картка'}: ${sent.display_name}${comment ? ` · ${comment}` : ''}${sent.note_attached ? ' [у картці]' : ''}`,
          status: 'sent', requested_by: caller, msg_id: sent.msg_id,
        })
        const warn = sent.phone_known ? '' : ' Номер цієї людини Telegram нам не показує, тож картка пішла без нього.'
        const inCard = sent.note_attached ? ' Коментар вкладено і в саму картку.' : ''
        const what = asFile ? `Файл .vcf з контактом ${sent.display_name}` : `Картку ${sent.display_name}`
        return ok(`${what} надіслано (msg_id ${sent.msg_id}).${inCard}${asFile ? '' : warn}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        recordOutbox({ chat_id: target.chat_id, kind: 'contact', text: `${asFile ? 'vcf' : 'картка'}: ${peer}`, status: 'failed', error: msg, requested_by: caller })
        return fail(`Не вдалось надіслати картку: ${msg}`)
      }
    }

    case 'tg_contact_note': {
      const live = needsLive()
      if (!live) return fail('Telegram не підключений.')
      const peer = String(args['peer'] ?? '')
      if (!peer) return fail('Потрібен параметр peer')

      const info = await readContactNote(live, peer)
      if (!info) return fail(`Не вдалось прочитати профіль "${peer}".`)

      const who = info.username ? `${info.display_name} @${info.username}` : info.display_name
      const status = info.is_contact ? 'у контактах' : 'не в контактах'
      const note = info.note || '(нотатки немає)'
      // A path, not the image: the file is already on disk and stays there, so
      // whoever needs to look at it reads it once instead of pulling it through
      // the model every time a profile is opened.
      const avatar = info.avatar ? `\nАватар: ${info.avatar}` : ''
      return ok(`#${info.peer_id} ${who} — ${status}\nНотатка в Telegram: ${note}${avatar}`)
    }

    case 'tg_write_note': {
      const live = needsLive()
      if (!live) return fail('Telegram не підключений.')
      const peer = String(args['peer'] ?? '')
      if (!peer) return fail('Потрібен параметр peer')
      const note = String(args['note'] ?? '')

      // Telegram зберігає нотатки на контактах. Мовчки додати людину в
      // контакти заради нотатки не можна — це видима зміна в акаунті, і
      // рішення про неї не наше.
      const before = await readContactNote(live, peer)
      if (before && !before.is_contact) {
        return fail(`${before.display_name} не в контактах власника — Telegram не має де тримати нотатку. Додай через tg_add_contact, якщо власник цього хоче.`)
      }

      const done = await writeContactNote(live, peer, note)
      if (!done) return fail(`Telegram не прийняв нотатку для "${peer}".`)

      if (args['sync_local'] !== false && before) {
        const person = getPerson(before.peer_id)
        if (person) setPersonProfile(before.peer_id, { note })
      }

      const name = before?.display_name ?? peer
      return ok(note ? `Нотатку записано в профіль ${name}.` : `Нотатку в профілі ${name} стерто.`)
    }

    case 'tg_import_contact': {
      const live = needsLive()
      if (!live) return fail('Telegram не підключений.')
      const phone = String(args['phone'] ?? '')
      const firstName = String(args['first_name'] ?? '').trim()
      if (!phone) return fail('Потрібен параметр phone')
      if (!firstName) return fail('Потрібне ім\'я: Telegram показуватиме контакт саме під ним.')

      const note = args['note'] !== undefined ? String(args['note']) : ''
      const res = await importContactByPhone(live, {
        phone,
        firstName,
        lastName: args['last_name'] !== undefined ? String(args['last_name']) : '',
        note,
      })

      if (!res.imported) return fail(`${res.phone}: ${res.reason}`)

      const person = getPerson(res.peer_id!)
      if (person && note) setPersonProfile(res.peer_id!, { note })
      return ok(`${res.display_name} (#${res.peer_id}) у контактах із номером ${res.phone}.`)
    }

    case 'tg_add_contact': {
      const live = needsLive()
      if (!live) return fail('Telegram не підключений.')
      const peer = String(args['peer'] ?? '')
      const firstName = String(args['first_name'] ?? '').trim()
      if (!peer) return fail('Потрібен параметр peer')
      if (!firstName) return fail('Потрібне ім\'я: Telegram показуватиме контакт саме під ним.')

      const res = await addContact(live, peer, {
        firstName,
        lastName: args['last_name'] !== undefined ? String(args['last_name']) : '',
        phone: args['phone'] !== undefined ? String(args['phone']) : '',
        note: args['note'] !== undefined ? String(args['note']) : '',
        sharePhone: args['share_phone'] === true,
      })

      if (!res.is_contact) {
        return fail(`Telegram прийняв запит, але ${res.display_name} так і не з'явився в контактах — імовірно, налаштування приватності цієї людини не дозволяють.`)
      }

      const person = getPerson(res.peer_id)
      if (person && res.note) setPersonProfile(res.peer_id, { note: res.note })

      const tail = res.note ? ` Нотатка: ${res.note}` : ''
      return ok(`${res.display_name} у контактах.${tail}`)
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

/**
 * The tool dispatcher, exposed for tests.
 *
 * Everything above it is transport; the decisions worth testing — who may be
 * written to, what is refused, what gets mirrored into our own tables — live
 * here, and reaching them through a socket handshake would test the socket.
 */
export const __testing = { callTool, TOOLS }
