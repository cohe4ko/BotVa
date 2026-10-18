/**
 * TGAP wired into a running bot: Telegram transport, the owner's chat, the
 * read-only draft run, and the grammY middleware.
 *
 * The middleware always swallows private messages from other bots, whether
 * TGAP is on or not. Without that, the regular handler would answer a bot
 * with "access denied", the bot could answer back, and two bots would be
 * talking to each other with no one in the loop.
 */

import { InputFile, type Bot, type Context, type NextFunction } from 'grammy'
import { ALLOWED_CHAT_ID, BOT_NAME, TELEGRAM_BOT_TOKEN, TGAP_ENABLED, TGAP_OWNER_NAME, TGAP_ACCEPT_FROM, TGAP_DRAFT_TOOLS } from '../config.js'
import { logger } from '../logger.js'
import { runAgent } from '../agent.js'
import { backgroundKey } from '../request-queue.js'
import { getModel } from '../model.js'
import { builtinToolId } from '../run-restrictions.js'
import { appendEventToDailyLog } from '../memory.js'
import { TgapService, buildDraftPrompt, buildNegotiatePrompt, parseCallbackData, type TgapTransport, type OwnerChannel } from './service.js'
import type { Card, Entity } from './envelope.js'
import { setTgap, getTgap } from './registry.js'
import { boxKeys } from '../secrets.js'

/** Builtin tools a reply draft may use. None of them acts on the world. */
export const DRAFT_BUILTIN_TOOLS = ['SearchMemory', 'GetCurrentTime', 'CurrencyRates']

const SWEEP_MS = 60_000

let service: TgapService | null = null
let ownerChat = ''

let sweepTimer: ReturnType<typeof setInterval> | undefined

export { getTgap }

export function buildCard(): Card {
  const owner = TGAP_OWNER_NAME || 'the owner'
  return {
    name: TGAP_OWNER_NAME ? `${TGAP_OWNER_NAME}'s assistant` : `${BOT_NAME || 'BotVa'} assistant`,
    owner: { display_name: owner },
    software: { name: 'BotVa' },
    tgap: ['0.1'],
    kinds: ['question', 'proposal', 'notice'],
    approval: 'owner_always',
    accepts_from: TGAP_ACCEPT_FROM,
    max_request_chars: 4000,
    // Other BotVa bots seal secrets to this key (§4.8)
    secrets: { x25519: boxKeys().publicKey },
  }
}

/** MCP server names behind the extra draft tools (mcp__<server>__<tool>). */
export function draftServers(tools: string[]): string[] {
  return [...new Set(tools.map(t => t.split('__')[1]).filter(Boolean))]
}

function makeTransport(bot: Bot): TgapTransport {
  const reply = (replyTo?: number) => replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}
  return {
    async sendText(to, text, entities, replyTo) {
      const m = await bot.api.sendMessage(to, text, {
        entities: entities as any,
        link_preview_options: { is_disabled: true },
        ...reply(replyTo),
      })
      return { chatId: m.chat.id, messageId: m.message_id }
    },
    async sendDocument(to, filename, content, caption, entities, replyTo) {
      const m = await bot.api.sendDocument(to, new InputFile(Buffer.from(content, 'utf8'), filename), {
        caption, caption_entities: entities as any, ...reply(replyTo),
      })
      return { chatId: m.chat.id, messageId: m.message_id }
    },
    async deleteMessage(chat, messageId) {
      await bot.api.deleteMessage(chat, messageId)
    },
    async downloadDocument(fileId) {
      const f = await bot.api.getFile(fileId)
      if (!f.file_path) throw new Error('no file path')
      const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${f.file_path}`)
      if (!res.ok) throw new Error(`download failed: ${res.status}`)
      return await res.text()
    },
  }
}

function makeOwnerChannel(bot: Bot): OwnerChannel {
  return {
    async post(chat, html, buttons) {
      const m = await bot.api.sendMessage(chat, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(buttons ? { reply_markup: { inline_keyboard: buttons.map(r => r.map(b => ({ text: b.text, callback_data: b.data }))) } } : {}),
      })
      return m.message_id
    },
    async edit(chat, messageId, html) {
      try {
        await bot.api.editMessageText(chat, messageId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      } catch (err) {
        logger.warn({ err, messageId }, '[tgap] could not edit the approval card')
      }
    },
    async askForText(chat, html) {
      const m = await bot.api.sendMessage(chat, html, { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } })
      return m.message_id
    },
  }
}

/** Start TGAP for this bot. No-op unless TGAP_ENABLED=1 and an owner chat is configured. */
export function initTgap(bot: Bot): void {
  if (!TGAP_ENABLED) return
  ownerChat = ALLOWED_CHAT_ID.split(',')[0]?.trim() ?? ''
  if (!ownerChat) {
    logger.warn('[tgap] TGAP_ENABLED=1 but ALLOWED_CHAT_ID is empty — not starting')
    return
  }

  service = new TgapService({
    transport: makeTransport(bot),
    owner: makeOwnerChannel(bot),
    ownerChat,
    card: buildCard(),
    logEvent: appendEventToDailyLog,
    log: logger,
    async draft(input) {
      const { createBuiltinMcpServer } = await import('../builtin-tools.js')
      // These tools never touch the grammY context, so a draft run needs none.
      const builtin = await createBuiltinMcpServer({} as Context, Number(ownerChat), undefined, DRAFT_BUILTIN_TOOLS)
      const { text } = await runAgent(
        buildDraftPrompt(input), undefined, undefined, backgroundKey('tgap', input.request.id), undefined,
        getModel(ownerChat), builtin?.server, undefined, undefined, draftServers(TGAP_DRAFT_TOOLS),
        undefined, 'medium', undefined, undefined,
        { allowTools: [...DRAFT_BUILTIN_TOOLS.map(builtinToolId), ...TGAP_DRAFT_TOOLS] },
      )
      if (!text || text.includes('{{agent.crash')) throw new Error('draft run produced no text')
      return text
    },
    async negotiate(input) {
      const { createBuiltinMcpServer } = await import('../builtin-tools.js')
      const builtin = await createBuiltinMcpServer({} as Context, Number(ownerChat), undefined, DRAFT_BUILTIN_TOOLS)
      const { text } = await runAgent(
        buildNegotiatePrompt(input), undefined, undefined, backgroundKey('tgap-negotiate', input.request.id), undefined,
        getModel(ownerChat), builtin?.server, undefined, undefined, draftServers(TGAP_DRAFT_TOOLS),
        undefined, 'medium', undefined, undefined,
        { allowTools: [...DRAFT_BUILTIN_TOOLS.map(builtinToolId), ...TGAP_DRAFT_TOOLS] },
      )
      if (!text || text.includes('{{agent.crash')) throw new Error('negotiation run produced no text')
      return text
    },
  })

  setTgap(service)

  sweepTimer = setInterval(() => {
    service?.sweep().catch(err => logger.warn({ err }, '[tgap] sweep failed'))
  }, SWEEP_MS)
  sweepTimer.unref?.()
  logger.info({ ownerChat, acceptFrom: TGAP_ACCEPT_FROM, draftTools: TGAP_DRAFT_TOOLS.length }, '[tgap] enabled')
}

export function stopTgap(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = undefined
  service = null
  setTgap(null)
}

const isOwner = (ctx: Context) => !!ownerChat && String(ctx.from?.id) === ownerChat

/** Must be registered before every other handler. */
export async function tgapMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const msg = ctx.message
  // 1. Another bot writing to us privately — never reaches the regular handlers.
  if (msg && ctx.chat?.type === 'private' && ctx.from?.is_bot) {
    if (!service) {
      logger.info({ from: ctx.from.username }, '[tgap] private message from a bot ignored (TGAP disabled)')
      return
    }
    try {
      await service.handleIncoming({
        fromId: ctx.from.id,
        username: ctx.from.username,
        messageId: msg.message_id,
        text: msg.text,
        entities: msg.entities as Entity[] | undefined,
        caption: msg.caption,
        captionEntities: msg.caption_entities as Entity[] | undefined,
        document: msg.document ? { fileId: msg.document.file_id, fileName: msg.document.file_name } : undefined,
      })
    } catch (err) {
      logger.error({ err, from: ctx.from.username }, '[tgap] failed to handle a bot message')
    }
    return
  }

  if (!service) return next()

  // 2. The owner pressing a button on an approval card.
  const data = ctx.callbackQuery?.data
  if (data?.startsWith('tgap:')) {
    if (!isOwner(ctx)) {
      await ctx.answerCallbackQuery()
      return
    }
    const parsed = parseCallbackData(data)
    let toast = ''
    try {
      toast = parsed ? await service.handleOwnerAction(parsed.action, parsed.requestId, parsed.variant) : ''
    } catch (err) {
      logger.error({ err, data }, '[tgap] owner action failed')
      toast = 'Не вдалося — подробиці в лозі'
    }
    await ctx.answerCallbackQuery(toast ? { text: toast } : undefined)
    return
  }

  // 3. The owner's own text in answer to an edit prompt.
  if (msg?.text && msg.reply_to_message && ctx.chat?.type === 'private' && isOwner(ctx)) {
    if (await service.handleOwnerText(msg.reply_to_message.message_id, msg.text)) return
  }

  return next()
}
