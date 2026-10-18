/**
 * /secret — the owner's side of the vault (secrets.ts) in Telegram.
 *
 *   /secret                  list secrets and active shares
 *   /secret add <name> [note]  then the value, as a reply; the reply is deleted
 *   /secret del <name>
 *   /secret share <name>     pick a bot, then how long it stays valid
 *
 * Registered right after the TGAP middleware, before everything else: the
 * reply carrying a value must never reach the agent, the history or the logs.
 */

import type { Api, Context, NextFunction } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { randomBytes } from 'node:crypto'
import { findChromeLogins, readChromeLogin, type ChromeLogin } from './chrome-import.js'
import { ALLOWED_CHAT_ID } from './config.js'
import { logger } from './logger.js'
import {
  SECRET_NAME, normalizeName, putSecret, deleteSecret, listSecrets, getSecretMeta, parseSecretInput, type SecretMeta,
} from './secrets.js'
import { getTgap } from './tgap/registry.js'
import * as tgapStore from './tgap/store.js'

/** Starts every value prompt — a reply to a message starting with it is a secret, whatever else happened. */
export const PROMPT_PREFIX = '🔐 Секрет «'
const PROMPT_TTL_MS = 15 * 60 * 1000

const pending = new Map<number, { name: string; note: string | null; at: number }>()
/** Chrome logins offered to the owner, by a short token that fits in callback data. */
const imports = new Map<string, { name: string; login: ChromeLogin; at: number }>()

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const ownerId = () => ALLOWED_CHAT_ID.split(',')[0]?.trim() ?? ''
const isOwner = (ctx: Context) => !!ownerId() && String(ctx.from?.id) === ownerId() && ctx.chat?.type === 'private'

export const HELP = [
  '🔐 <b>Сховище секретів</b>',
  'Логіни, паролі, ключі API. Агент знає лише назви й підставляє значення в інструменти, не бачачи їх.',
  '',
  '<code>/secret add назва [примітка]</code>: потім надішли значення відповіддю. Можна рядками <code>login: …</code>, <code>password: …</code>, <code>url: …</code> або одним значенням. Повідомлення одразу видаляється.',
  '<code>/secret del назва</code>: видалити',
  '<code>/secret share назва</code>: передати іншому боту на BotVa (зашифровано, з твого підтвердження)',
  '<code>/secret import назва сайт</code>: взяти логін, збережений у Google Chrome на цьому Mac. Пароль не йде ні через чат, ні через Telegram.',
].join('\n')

/**
 * Offer the owner the Chrome logins saved for `site`, one button each. Nothing
 * is read until a button is pressed. Returns how many were offered.
 */
export async function offerChromeImport(api: Api, name: string, site: string): Promise<number> {
  const n = normalizeName(name)
  if (!SECRET_NAME.test(n)) throw new Error(`Bad secret name "${name}": a-z, 0-9, _ and -, up to 24 characters`)
  const owner = ownerId()
  if (!owner) throw new Error('No owner chat configured')
  const found = findChromeLogins(site).slice(0, 10)
  if (!found.length) return 0
  for (const [k, v] of imports) if (Date.now() - v.at > PROMPT_TTL_MS) imports.delete(k)
  const rows: InlineKeyboardButton[][] = found.map(login => {
    const token = randomBytes(6).toString('base64url')
    imports.set(token, { name: n, login, at: Date.now() })
    const where = login.origin.replace(/^https?:\/\//, '').replace(/\/$/, '')
    return [{ text: `${login.username || '(без логіна)'} · ${where}`.slice(0, 60), callback_data: `sec:imp:${token}` }]
  })
  rows.push([{ text: '✖ Скасувати', callback_data: 'sec:cancel' }])
  const exists = getSecretMeta(n)
  await api.sendMessage(Number(owner), [
    `🔐 Зберегти в сховище як «${esc(n)}»${exists ? ' (замінить наявний)' : ''} логін із Google Chrome?`,
    '<i>Пароль піде з Chrome одразу в сховище: ні агент, ні чат, ні Telegram його не побачать.</i>',
    'Обери, який саме:',
  ].join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } })
  return found.length
}

function fmtDate(s: number): string {
  return new Date(s * 1000).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
}

function secretLine(m: SecretMeta): string {
  return [
    `• <b>${esc(m.name)}</b>: ${m.fields.map(f => `<code>${esc(f)}</code>`).join(', ')}`,
    m.note ? ` · ${esc(m.note)}` : '',
    m.source ? ` · від ${esc(m.source)}` : '',
    m.expires_at ? ` · до ${fmtDate(m.expires_at)}` : '',
  ].join('')
}

/** The /secret list: secrets with their buttons, then what is shared with whom. */
export function listView(): { html: string; keyboard: InlineKeyboardButton[][] } {
  const secrets = listSecrets()
  const tgap = getTgap()
  const shares = tgap?.activeShares() ?? []
  const lines = [secrets.length ? '🔐 <b>Секрети</b>' : '🔐 Сховище порожнє.']
  lines.push(...secrets.map(secretLine))
  if (shares.length) {
    lines.push('', '📤 <b>Передано</b>')
    const words: Record<string, string> = { awaiting_key: 'чекає ключа', sent: 'чекає підтвердження', delivered: 'прийнято' }
    lines.push(...shares.map(s => `• «${esc(s.name)}» → ${esc(s.peer)}: ${words[s.state] ?? s.state}`))
  }
  if (!secrets.length) lines.push('', HELP)
  const keyboard: InlineKeyboardButton[][] = secrets.map(m => [
    ...(tgap ? [{ text: `🔑 Передати ${m.name}`, callback_data: `sec:share:${m.name}` }] : []),
    { text: `🗑 ${m.name}`, callback_data: `sec:del:${m.name}` },
  ])
  keyboard.push(...shares.map(s => [{ text: `↩️ Відкликати «${s.name}» у ${s.peer}`, callback_data: `sec:revoke:${s.id}` }]))
  return { html: lines.join('\n'), keyboard }
}

async function replyList(ctx: Context): Promise<void> {
  const { html, keyboard } = listView()
  await ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) })
}

function peerButtons(name: string): InlineKeyboardButton[][] {
  return tgapStore.listPeers()
    .filter(p => p.trust !== 'blocked' && p.protocol !== 'plain')
    .slice(0, 12)
    .map(p => [{ text: `@${p.username ?? p.bot_id}${p.trust === 'unknown' ? ' ⚠️' : ''}`, callback_data: `sec:to:${name}:${p.bot_id}` }])
}

async function askToShare(ctx: Context, name: string): Promise<void> {
  if (!getTgap()) {
    await ctx.reply('Передача секретів працює через TGAP: увімкни TGAP_ENABLED=1 у .env бота.')
    return
  }
  const rows = peerButtons(name)
  if (!rows.length) {
    await ctx.reply('Немає ботів, з якими можна поділитися: спершу хай бот поспілкується з ними (AskExternalBot), щоб вони познайомились.')
    return
  }
  await ctx.reply(`🔑 Кому передати «${esc(name)}»? (⚠️: ти ще не позначав цього бота як знайомого)`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } })
}

async function handleCommand(ctx: Context, text: string): Promise<void> {
  const [, sub = '', name = '', ...rest] = text.trim().split(/\s+/)
  const n = normalizeName(name)
  switch (sub.toLowerCase()) {
    case '':
    case 'list':
      return replyList(ctx)
    case 'add': {
      if (!SECRET_NAME.test(n)) {
        await ctx.reply('Назва: латиниця, цифри, <code>_</code> і <code>-</code>, до 24 символів. Наприклад: <code>/secret add bitrix Адмінка сайту</code>', { parse_mode: 'HTML' })
        return
      }
      const exists = getSecretMeta(n)
      const m = await ctx.reply(
        `${PROMPT_PREFIX}${esc(n)}»${exists ? ' (замінить наявний)' : ''}: надішли значення <b>відповіддю на це повідомлення</b>.\n` +
        'Рядками <code>login: …</code> / <code>password: …</code> / <code>url: …</code> або одним значенням. Я одразу видалю твоє повідомлення.',
        { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'login: …  password: …' } },
      )
      pending.set(m.message_id, { name: n, note: rest.join(' ').trim() || null, at: Date.now() })
      return
    }
    case 'del':
    case 'delete':
    case 'rm':
      if (!getSecretMeta(n)) { await ctx.reply(`Секрету «${esc(n)}» немає.`, { parse_mode: 'HTML' }); return }
      await ctx.reply(`Видалити секрет «${esc(n)}»?`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🗑 Видалити', callback_data: `sec:delok:${n}` }, { text: 'Ні', callback_data: 'sec:cancel' }]] } })
      return
    case 'share':
      if (!getSecretMeta(n)) { await ctx.reply(`Секрету «${esc(n)}» немає.`, { parse_mode: 'HTML' }); return }
      return askToShare(ctx, n)
    case 'import': {
      const site = rest[0] ?? ''
      if (!SECRET_NAME.test(n) || !site) {
        await ctx.reply('Наприклад: <code>/secret import shop shop.com.ua/bitrix/admin</code>', { parse_mode: 'HTML' })
        return
      }
      if (await offerChromeImport(ctx.api, n, site) === 0) await ctx.reply(`У Google Chrome немає збережених паролів для <code>${esc(site)}</code>.`, { parse_mode: 'HTML' })
      return
    }
    default:
      await ctx.reply(HELP, { parse_mode: 'HTML' })
  }
}

/** The owner's reply with the value. Deleted before anything else happens. */
async function handleValue(ctx: Context, promptId: number, text: string): Promise<void> {
  const chat = ctx.chat!.id
  try { await ctx.api.deleteMessage(chat, ctx.message!.message_id) } catch (err) {
    logger.warn({ err }, '[secrets] could not delete the message with a secret value')
    await ctx.reply('⚠️ Не вдалося видалити твоє повідомлення зі значенням. Видали його сам.')
  }
  const p = pending.get(promptId)
  pending.delete(promptId)
  if (!p || Date.now() - p.at > PROMPT_TTL_MS) {
    await ctx.reply('Цей запит застарів, значення не збережено. Почни знову: /secret add назва')
    return
  }
  try {
    const values = parseSecretInput(text)
    putSecret(p.name, values, { note: p.note })
    const fields = Object.keys(values).map(f => `<code>${esc(f)}</code>`).join(', ')
    await ctx.api.editMessageText(chat, promptId, `🔐 Збережено «${esc(p.name)}»: ${fields}. Твоє повідомлення видалено.\nАгент користується ним як <code>{{secret:${esc(p.name)}.поле}}</code>.`, { parse_mode: 'HTML' })
  } catch (err: any) {
    await ctx.reply(`Не збережено: ${esc(String(err?.message ?? err))}`, { parse_mode: 'HTML' })
  }
}

async function handleCallback(ctx: Context, data: string): Promise<string> {
  const [, action, a = '', b = '', c = ''] = data.split(':')
  const tgap = getTgap()
  const msgId = ctx.callbackQuery?.message?.message_id
  const editDone = async (html: string) => {
    if (msgId) await ctx.api.editMessageText(ctx.chat!.id, msgId, html, { parse_mode: 'HTML' }).catch(() => {})
  }
  switch (action) {
    case 'cancel':
      await editDone('Скасовано.')
      return ''
    case 'del':
      await ctx.reply(`Видалити секрет «${esc(a)}»?`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🗑 Видалити', callback_data: `sec:delok:${a}` }, { text: 'Ні', callback_data: 'sec:cancel' }]] } })
      return ''
    case 'delok':
      await editDone(deleteSecret(a) ? `🗑 Секрет «${esc(a)}» видалено.` : `Секрету «${esc(a)}» уже немає.`)
      return 'Видалено'
    case 'share':
      await askToShare(ctx, a)
      return ''
    case 'to':
      if (!tgap) return 'TGAP вимкнено'
      await tgap.proposeShare(a, Number(b))
      return ''
    case 'ttl': {
      if (!tgap) return 'TGAP вимкнено'
      const r = await tgap.shareSecret(a, Number(b), Number(c))
      await editDone(r === 'sent' ? `🔑 «${esc(a)}»: надсилаю.` : `🔑 «${esc(a)}»: чекаю ключа від бота.`)
      return r === 'sent' ? 'Надіслано' : 'Чекаю ключа'
    }
    case 'revoke':
      if (!tgap) return 'TGAP вимкнено'
      return tgap.revokeShare(a)
    case 'imp': {
      const p = imports.get(a)
      if (!p || Date.now() - p.at > PROMPT_TTL_MS) {
        await editDone('Цей запит застарів. Попроси ще раз або: <code>/secret import назва сайт</code>')
        return 'Застаріло'
      }
      for (const [k, v] of imports) if (v.name === p.name) imports.delete(k)
      const values = await readChromeLogin(p.login.profile, p.login.rowid)
      putSecret(p.name, values, { note: `з Chrome: ${values.url}` })
      logger.info({ name: p.name, origin: values.url }, '[secrets] imported a Chrome login')
      await editDone(`🔐 Збережено «${esc(p.name)}» з Chrome: <code>url</code>, <code>login</code>, <code>password</code>.\nАгент користується ним як <code>{{secret:${esc(p.name)}.поле}}</code>.`)
      return 'Збережено'
    }
  }
  return ''
}

export async function secretsMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const msg = ctx.message
  const reply = msg?.reply_to_message
  // A reply to a value prompt is a secret whoever sent it and whatever we remember: never let it through
  if (msg && reply?.from?.is_bot && reply.text?.startsWith(PROMPT_PREFIX) && ctx.chat?.type === 'private') {
    if (isOwner(ctx)) await handleValue(ctx, reply.message_id, msg.text ?? msg.caption ?? '')
    return
  }
  if (msg?.text && /^\/secrets?(@\w+)?(\s|$)/i.test(msg.text)) {
    if (!isOwner(ctx)) return
    try { await handleCommand(ctx, msg.text) } catch (err: any) {
      logger.error({ err }, '[secrets] command failed')
      await ctx.reply(`Не вдалося: ${esc(String(err?.message ?? err))}`, { parse_mode: 'HTML' })
    }
    return
  }
  const data = ctx.callbackQuery?.data
  if (data?.startsWith('sec:')) {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery(); return }
    let toast = ''
    try { toast = await handleCallback(ctx, data) } catch (err: any) {
      logger.error({ err, data }, '[secrets] action failed')
      toast = String(err?.message ?? 'Не вдалося').slice(0, 190)
    }
    await ctx.answerCallbackQuery(toast ? { text: toast } : undefined)
    return
  }
  return next()
}

export function _resetSecretsUiForTests(): void {
  pending.clear()
}
