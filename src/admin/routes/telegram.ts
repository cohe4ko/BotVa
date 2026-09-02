/**
 * Admin — Telegram Observer.
 *
 * Connection (login flow), daemon control, live log, chat registry with per-chat
 * mode and send permission, message feed (incoming / outgoing / recent), outbox.
 */

import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, icon } from '../views/layout.js'
import { guideBlock } from '../views/components.js'
import { getProjectRoot, getBotNames } from '../db-multi.js'
import { execFile } from 'child_process'
import { join } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { getObserverStatus, readLogTail } from '../../telegram/status.js'
import {
  listChats, countChats, listUnreadChats, getRecentMessages, getMessages, listOutbox,
  setChatMode, setChatCanSend, getChat, countMessages, countForeignRows, purgeForeignRows, setAutoReply, setAutoReplyPrompt, baselineAutoReply,
  type ChatMode, type TgMessage, type TgChat, type ListChatsOptions,
} from '../../telegram/db.js'
import { logger } from '../../logger.js'
import { openObserver } from '../../telegram/bridge.js'
import { getLoginState, startLogin, submitCode, submitPassword, cancelLogin } from '../../telegram/auth.js'

const app = new Hono<I18nEnv>()

const CHAT_MODES: ChatMode[] = ['ignore', 'log-only', 'facts-only', 'full']

const MODE_HINT: Record<ChatMode, string> = {
  'ignore': 'Повністю поза системою',
  'log-only': 'Логувати, нічого не витягати',
  'facts-only': 'Логувати + витягати факти (коли конвеєр увімкнено)',
  'full': 'Логувати + факти + задачі',
}

function runControl(action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; output: string }> {
  const script = join(getProjectRoot(), 'scripts', 'telegram-observer.sh')
  return new Promise((resolve) => {
    execFile('bash', [script, action], { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() })
    })
  })
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function kindBadge(kind: string) {
  const labels: Record<string, string> = {
    user: '👤 приватний', bot: '🤖 бот', group: '👥 група',
    supergroup: '📢 супергрупа', channel: '📣 канал',
  }
  return labels[kind] ?? kind
}

function modeBadge(mode: ChatMode) {
  const cls = mode === 'ignore' ? 'badge-missing' : mode === 'full' ? 'badge-set' : ''
  return html`<span class="badge ${cls}" style="font-size:0.68rem">${mode}</span>`
}

// --- Fragments ---

function renderStatus(t: TFunc) {
  const s = getObserverStatus()
  const login = getLoginState()
  const foreign = countForeignRows()

  return html`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">${icon('activity', 12)} Демон</div>
        <div class="stat-number" style="font-size:1.1rem">
          ${s.running
            ? html`<span class="badge badge-set">${icon('check', 11)} працює${s.pid ? ` · ${s.pid}` : ''}</span>`
            : html`<span class="badge badge-missing">${icon('x', 11)} зупинений</span>`}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('key', 12)} Сесія</div>
        <div class="stat-number" style="font-size:1.1rem">
          ${login.hasSession
            ? html`<span class="badge badge-set">${icon('check', 11)} є</span>`
            : html`<span class="badge badge-missing">${icon('x', 11)} немає</span>`}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('plug', 12)} MCP-сокет</div>
        <div class="stat-number" style="font-size:1.1rem">
          ${s.socket
            ? html`<span class="badge badge-set">${icon('check', 11)} слухає</span>`
            : html`<span class="badge badge-missing">${icon('x', 11)} немає</span>`}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('message-square', 12)} Повідомлень</div>
        <div class="stat-number">${s.messages.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('arrow-down-left', 12)} Вхідних</div>
        <div class="stat-number">${s.messages.incoming}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('arrow-up-right', 12)} Вихідних</div>
        <div class="stat-number">${s.messages.outgoing}</div>
      </div>
    </div>

    ${!s.credentials ? html`
      <div class="alert alert-warning" style="margin-top:0.75rem">
        ${icon('alert-triangle', 14)} <strong>TELEGRAM_API_ID / TELEGRAM_API_HASH не задані.</strong>
        Отримай їх на <a href="https://my.telegram.org" target="_blank" rel="noreferrer">my.telegram.org</a>
        → API development tools, і додай у <code>.env</code> в корені проєкту.
      </div>` : ''}

    ${foreign.messages > 0 || foreign.chats > 0 ? html`
      <div class="alert alert-warning" style="margin-top:0.75rem">
        ${icon('alert-triangle', 14)} <strong>У базі дані іншого акаунта:</strong>
        ${foreign.chats} чатів, ${foreign.messages} повідомлень.
        Вони не показуються і не потрапляють у пошук — «вхідне» та «вихідне» там означають протилежне.
        <div style="margin-top:0.5rem">
          <button class="btn-sm secondary outline"
                  hx-post="/telegram/purge-foreign"
                  hx-target="#tg-status" hx-swap="innerHTML"
                  hx-confirm="Видалити ${foreign.chats} чатів і ${foreign.messages} повідомлень іншого акаунта? Це незворотно.">
            ${icon('trash-2', 11)} Видалити назавжди
          </button>
        </div>
      </div>` : ''}

    <div style="display:flex;gap:0.4rem;margin-top:0.75rem;flex-wrap:wrap">
      ${s.running
        ? html`<button class="btn-sm secondary outline" hx-post="/telegram/control/stop" hx-target="#tg-status" hx-swap="innerHTML">${icon('square', 11)} Зупинити</button>
               <button class="btn-sm outline" hx-post="/telegram/control/restart" hx-target="#tg-status" hx-swap="innerHTML">${icon('refresh-cw', 11)} Рестарт</button>`
        : html`<button class="btn-sm" hx-post="/telegram/control/start" hx-target="#tg-status" hx-swap="innerHTML">${icon('play', 11)} Запустити</button>`}
      <button class="btn-sm outline" hx-get="/telegram/status" hx-target="#tg-status" hx-swap="innerHTML">${icon('rotate-cw', 11)} Оновити</button>
    </div>

    ${renderLoginBlock(login)}
  `
}

function renderLoginBlock(login: ReturnType<typeof getLoginState>) {
  if (!login.hasCredentials) return ''

  if (login.step === 'authorized' || (login.hasSession && login.step === 'idle')) {
    return html`
      <div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--mc-border);border-radius:8px">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem">
          ${icon('shield-check', 14)} <strong>Акаунт підключено</strong>
        </div>
        <p style="font-size:0.8rem;color:var(--mc-text-dim);margin:0 0 0.5rem">
          Сесія збережена у <code>store/telegram.session</code> (права 600). Відкликати доступ можна
          в Telegram → Settings → Devices.
        </p>
        <button class="btn-sm secondary outline"
          hx-post="/telegram/login/reset" hx-target="#tg-status" hx-swap="innerHTML"
          hx-confirm="Видалити збережену сесію? Доведеться авторизуватись заново.">
          ${icon('log-out', 11)} Відв'язати акаунт
        </button>
      </div>`
  }

  const body = login.step === 'code_sent'
    ? html`
        <p style="font-size:0.8rem;color:var(--mc-text-dim);margin:0 0 0.5rem">
          Код надіслано на ${login.phone}. Введи його з Telegram.
        </p>
        <form hx-post="/telegram/login/code" hx-target="#tg-status" hx-swap="innerHTML" style="display:flex;gap:0.4rem;flex-wrap:wrap">
          <input type="text" name="code" placeholder="12345" inputmode="numeric" autocomplete="one-time-code"
                 style="max-width:160px;margin:0" required>
          <button class="btn-sm" type="submit">${icon('check', 11)} Підтвердити</button>
          <button class="btn-sm secondary outline" type="button"
                  hx-post="/telegram/login/cancel" hx-target="#tg-status" hx-swap="innerHTML">Скасувати</button>
        </form>`
    : login.step === 'password_needed'
    ? html`
        <p style="font-size:0.8rem;color:var(--mc-text-dim);margin:0 0 0.5rem">
          Увімкнена двофакторна автентифікація. Введи пароль хмарного захисту.
        </p>
        <form hx-post="/telegram/login/password" hx-target="#tg-status" hx-swap="innerHTML" style="display:flex;gap:0.4rem;flex-wrap:wrap">
          <input type="password" name="password" placeholder="Пароль 2FA" style="max-width:240px;margin:0" required>
          <button class="btn-sm" type="submit">${icon('check', 11)} Увійти</button>
          <button class="btn-sm secondary outline" type="button"
                  hx-post="/telegram/login/cancel" hx-target="#tg-status" hx-swap="innerHTML">Скасувати</button>
        </form>`
    : html`
        <p style="font-size:0.8rem;color:var(--mc-text-dim);margin:0 0 0.5rem">
          Введи номер телефону акаунта в міжнародному форматі. Telegram надішле код підтвердження.
        </p>
        <form hx-post="/telegram/login/start" hx-target="#tg-status" hx-swap="innerHTML" style="display:flex;gap:0.4rem;flex-wrap:wrap">
          <input type="tel" name="phone" placeholder="+380..." style="max-width:200px;margin:0" required>
          <button class="btn-sm" type="submit">${icon('send', 11)} Надіслати код</button>
        </form>`

  return html`
    <div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--mc-border);border-radius:8px">
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem">
        ${icon('log-in', 14)} <strong>Підключення акаунта</strong>
      </div>
      ${body}
    </div>`
}

/** Chats per page — an account can hold thousands, so nothing renders unbounded. */
const CHATS_PER_PAGE = 25

interface ChatQuery {
  page: number
  search: string
  mode: ChatMode | ''
  activeDays: number
}

/**
 * Read the list state from plain values.
 *
 * Accepts a bag rather than the request so that a POST (mode toggle) can
 * restore the same page and filters from its body — otherwise every toggle
 * would bounce the user back to page one of an unfiltered list.
 */
function parseChatQuery(values: Record<string, string | undefined>): ChatQuery {
  const page = Math.max(1, Number(values['page'] ?? 1) || 1)
  const search = (values['q'] ?? '').slice(0, 100)
  const rawMode = values['mode'] ?? ''
  const mode = (CHAT_MODES as string[]).includes(rawMode) ? rawMode as ChatMode : ''
  const activeDays = Number(values['days'] ?? 0) || 0
  return { page, search, mode, activeDays }
}

function chatQueryToOptions(q: ChatQuery): ListChatsOptions {
  return {
    search: q.search || undefined,
    mode: q.mode || undefined,
    activeSince: q.activeDays > 0 ? Math.floor(Date.now() / 1000) - q.activeDays * 86400 : undefined,
    limit: CHATS_PER_PAGE,
    offset: (q.page - 1) * CHATS_PER_PAGE,
  }
}

function chatsUrl(q: ChatQuery, page: number): string {
  const params = new URLSearchParams()
  params.set('page', String(page))
  if (q.search) params.set('q', q.search)
  if (q.mode) params.set('mode', q.mode)
  if (q.activeDays) params.set('days', String(q.activeDays))
  return `/telegram/chats?${params.toString()}`
}

/** htmx-driven pager: swaps the fragment in place instead of reloading the page. */
function chatPager(q: ChatQuery, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / CHATS_PER_PAGE))
  if (totalPages <= 1) return html`<p style="font-size:0.72rem;color:var(--mc-text-dim);margin-top:0.4rem">Всього: ${total}</p>`

  const window = 2
  const pages: (number | '…')[] = []
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= q.page - window && i <= q.page + window)) pages.push(i)
    else if (pages[pages.length - 1] !== '…') pages.push('…')
  }

  return html`
    <div style="display:flex;align-items:center;gap:0.3rem;flex-wrap:wrap;margin-top:0.5rem">
      ${pages.map(p => p === '…'
        ? html`<span style="color:var(--mc-text-dim);padding:0 0.2rem">…</span>`
        : html`<button class="btn-sm ${p === q.page ? '' : 'outline'}"
                 style="min-width:32px;padding:0 0.4rem"
                 hx-get="${chatsUrl(q, p)}" hx-target="#tg-chats" hx-swap="innerHTML">${p}</button>`)}
      <span style="font-size:0.72rem;color:var(--mc-text-dim);margin-left:0.4rem">
        сторінка ${q.page} з ${totalPages} · всього ${total}
      </span>
    </div>`
}

/**
 * Filter bar — rendered once with the page, never inside the swapped fragment.
 *
 * htmx replaces the target's innerHTML, so a search box living inside the
 * fragment gets destroyed and recreated on every keystroke batch: the caret
 * jumps out mid-word. Keeping the controls outside #tg-chats means only the
 * table is redrawn and the field keeps focus.
 *
 * The list filter is named list_mode so it cannot collide with the per-row mode
 * select, which posts its own `mode` value.
 */
function chatFilters() {
  const dayOptions: { value: number; label: string }[] = [
    { value: 0, label: 'за весь час' },
    { value: 7, label: 'активні 7 днів' },
    { value: 30, label: 'активні 30 днів' },
    { value: 90, label: 'активні 90 днів' },
  ]
  return html`
    <div style="display:flex;gap:0.4rem;margin-bottom:0.5rem;flex-wrap:wrap;align-items:center">
      <input type="search" name="q" placeholder="Пошук чату за назвою, @username або id"
             style="margin:0;max-width:320px;flex:1"
             hx-get="/telegram/chats" hx-target="#tg-chats" hx-swap="innerHTML"
             hx-sync="this:replace"
             hx-trigger="keyup changed delay:350ms, search"
             hx-include="[name='list_mode'],[name='days']">
      <select name="list_mode" style="margin:0;max-width:150px;font-size:0.8rem"
              hx-get="/telegram/chats" hx-target="#tg-chats" hx-swap="innerHTML"
              hx-trigger="change" hx-include="[name='q'],[name='days']">
        <option value="">всі режими</option>
        ${CHAT_MODES.map(m => html`<option value="${m}">${m}</option>`)}
      </select>
      <select name="days" style="margin:0;max-width:170px;font-size:0.8rem"
              hx-get="/telegram/chats" hx-target="#tg-chats" hx-swap="innerHTML"
              hx-trigger="change" hx-include="[name='q'],[name='list_mode']">
        ${dayOptions.map(o => html`<option value="${o.value}">${o.label}</option>`)}
      </select>
      <span class="htmx-indicator" style="font-size:0.72rem;color:var(--mc-text-dim)">шукаю…</span>
    </div>`
}

/**
 * Pull recent history and the owner's own messages into the log for one chat.
 *
 * Runs detached: the admin request must not wait on Telegram, and a failure
 * here is a thinner first reply, not a broken setting.
 */
async function seedChatArchive(chatId: string, title: string): Promise<void> {
  try {
    const obs = await openObserver()
    try {
      const raw = await obs.call('tg_seed_chat', { chat: chatId, limit: 100, own_limit: 50 })
      const result = JSON.parse(raw) as { stored: number; newest_msg_id: number }

      // Everything just pulled in existed before the chat was switched on, so it
      // counts as handled. Without this the bot would open by answering a
      // conversation that ended weeks ago.
      if (result.newest_msg_id > 0) baselineAutoReply(chatId, result.newest_msg_id)
      logger.info({ chatId, title, ...result }, '[telegram] seeded archive for a newly enabled chat')
    } finally {
      await obs.close()
    }
  } catch (err) {
    logger.warn({ err, chatId }, '[telegram] could not seed the archive; the chat will fill up as messages arrive')
  }
}

/** A room with more than two people in it: most messages are not for the owner. */
function isGroupKind(kind: string): boolean {
  return kind === 'group' || kind === 'supergroup' || kind === 'channel'
}

/**
 * Delay presets, seconds.
 *
 * 30 s is a live conversation — the bot keeps a dialogue going while the owner
 * is away from the phone. Longer values are a safety net: answer only what has
 * clearly been left hanging.
 */
const AUTO_REPLY_DELAYS: [number, string][] = [
  [30, '30 с'], [60, '1 хв'], [120, '2 хв'], [300, '5 хв'],
  [600, '10 хв'], [1800, '30 хв'], [3600, '1 год'], [10800, '3 год'],
]

/**
 * Which bot answers here, after how long, and whether an opened chat counts.
 *
 * Sending as the account holder is off unless a bot is named, and switching it
 * on marks everything already logged as handled — turning the feature on must
 * never fire an answer into a conversation that ended last week.
 */
function autoReplyCell(c: TgChat, bots: string[]) {
  const include = "[name='q'],[name='list_mode'],[name='days'],[name='page']"
  const post = `/telegram/chat/${encodeURIComponent(c.chat_id)}/auto-reply`
  const on = !!c.auto_reply_bot

  return html`
    <div style="display:flex;flex-direction:column;gap:0.2rem">
      <select style="margin:0;font-size:0.75rem;max-width:120px"
              hx-post="${post}" hx-target="#tg-chats" hx-swap="innerHTML"
              hx-include="${include}"
              hx-vals="js:{bot: event.target.value}" hx-trigger="change">
        <option value=""${!on ? ' selected' : ''}>— вимкнено —</option>
        ${bots.map(b => html`<option value="${b}"${b === c.auto_reply_bot ? ' selected' : ''}>${b}</option>`)}
      </select>
      ${on ? html`
        <select style="margin:0;font-size:0.7rem;max-width:120px"
                hx-post="${post}" hx-target="#tg-chats" hx-swap="innerHTML"
                hx-include="${include}"
                hx-vals="js:{after_s: event.target.value}" hx-trigger="change">
          ${AUTO_REPLY_DELAYS.map(([s, label]) =>
            html`<option value="${s}"${s === c.auto_reply_after_s ? ' selected' : ''}>через ${label}</option>`)}
        </select>
        <label style="font-size:0.68rem;color:var(--mc-text-dim);display:flex;gap:0.25rem;align-items:center">
          <input type="checkbox" style="margin:0"${c.auto_reply_require_unread ? ' checked' : ''}
                 hx-post="${post}" hx-target="#tg-chats" hx-swap="innerHTML"
                 hx-include="${include}"
                 hx-vals="js:{require_unread: event.target.checked ? '1' : '0'}" hx-trigger="change">
          лише непрочитане
        </label>
        <label style="font-size:0.68rem;color:var(--mc-text-dim);display:flex;gap:0.25rem;align-items:center">
          <input type="checkbox" style="margin:0"${c.auto_reply_mention_only ? ' checked' : ''}
                 hx-post="${post}" hx-target="#tg-chats" hx-swap="innerHTML"
                 hx-include="${include}"
                 hx-vals="js:{mention_only: event.target.checked ? '1' : '0'}" hx-trigger="change">
          лише згадки${isGroupKind(c.kind) ? '' : ' і відповіді'}
        </label>
        ${!c.can_send ? html`
          <span style="font-size:0.66rem;color:var(--mc-warning,#c47f00)">
            ${icon('alert-triangle', 10)} увімкни «Відправку» — інакше бот не зможе написати
          </span>` : ''}
        <a href="/telegram/chat/${encodeURIComponent(c.chat_id)}#autoreply"
           style="font-size:0.66rem">${c.auto_reply_prompt ? 'промт ✎' : 'задати промт'}</a>
        ${c.auto_reply_last_ts ? html`
          <span style="font-size:0.66rem;color:var(--mc-text-dim)">відповів ${fmtTime(c.auto_reply_last_ts)}</span>` : ''}
      ` : ''}
    </div>`
}

function renderChats(chats: TgChat[], q: ChatQuery, total: number, bots: string[]) {
  if (chats.length === 0) {
    return html`
      <input type="hidden" name="page" value="1">
      <p style="color:var(--mc-text-dim);font-size:0.85rem">
        ${q.search || q.mode || q.activeDays
          ? 'Нічого не знайдено за цим фільтром.'
          : 'Чатів ще немає. Вони з\'являться після запуску демона і перших повідомлень.'}
      </p>`
  }

  return html`
    <input type="hidden" name="page" value="${q.page}">
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Чат</th><th>Тип</th><th>Непрочитані</th><th>Режим</th><th>Відправка</th><th>Автовідповідь</th><th>Останнє</th><th></th></tr>
        </thead>
        <tbody>
          ${chats.map(c => html`
            <tr>
              <td>
                <a href="/telegram/chat/${encodeURIComponent(c.chat_id)}"><strong>${c.title}</strong></a>
                ${c.username ? html`<div style="font-size:0.7rem;color:var(--mc-text-dim)">@${c.username}</div>` : ''}
              </td>
              <td style="font-size:0.75rem">${kindBadge(c.kind)}</td>
              <td>${c.unread > 0 ? html`<span class="badge">${c.unread}</span>` : '—'}</td>
              <td>
                <select style="margin:0;font-size:0.75rem;max-width:130px"
                        hx-post="/telegram/chat/${encodeURIComponent(c.chat_id)}/mode"
                        hx-target="#tg-chats" hx-swap="innerHTML"
                        hx-include="[name='q'],[name='list_mode'],[name='days'],[name='page']"
                        hx-vals="js:{mode: event.target.value}" hx-trigger="change">
                  ${CHAT_MODES.map(m => html`<option value="${m}"${m === c.mode ? ' selected' : ''}>${m}</option>`)}
                </select>
              </td>
              <td>
                <input type="checkbox" style="margin:0"${c.can_send ? ' checked' : ''}
                       hx-post="/telegram/chat/${encodeURIComponent(c.chat_id)}/can-send"
                       hx-target="#tg-chats" hx-swap="innerHTML"
                       hx-include="[name='q'],[name='list_mode'],[name='days'],[name='page']"
                       hx-vals="js:{can_send: event.target.checked ? '1' : '0'}" hx-trigger="change">
              </td>
              <td>${autoReplyCell(c, bots)}</td>
              <td style="font-size:0.72rem;color:var(--mc-text-dim)">${c.last_msg_ts ? fmtTime(c.last_msg_ts) : '—'}</td>
              <td>${modeBadge(c.mode)}</td>
            </tr>`)}
        </tbody>
      </table>
    </div>
    ${chatPager(q, total)}
    <p style="font-size:0.72rem;color:var(--mc-text-dim);margin-top:0.4rem">
      ${CHAT_MODES.map(m => html`<code>${m}</code> — ${MODE_HINT[m]}. `)}
      Боти завжди <code>ignore</code> за замовчуванням, щоб бот BotVa не читав власні повідомлення.
      Чати без активності понад 30 днів реєструються як <code>ignore</code> — вмикай вручну, якщо потрібні.
    </p>`
}

function renderMessages(rows: TgMessage[], showChat = true) {
  if (rows.length === 0) {
    return html`<p style="color:var(--mc-text-dim);font-size:0.85rem">Порожньо.</p>`
  }
  return html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th style="width:110px">Час</th>${showChat ? html`<th style="width:150px">Чат</th>` : ''}<th style="width:40px"></th><th style="width:130px">Хто</th><th>Текст</th></tr>
        </thead>
        <tbody>
          ${rows.map(m => {
            const chat = showChat ? getChat(m.chat_id) : null
            return html`
              <tr${m.deleted_ts ? ' style="opacity:0.45"' : ''}>
                <td style="font-size:0.72rem;color:var(--mc-text-dim);white-space:nowrap">${fmtTime(m.ts)}</td>
                ${showChat ? html`<td style="font-size:0.75rem">${chat?.title ?? m.chat_id}</td>` : ''}
                <td>${m.direction === 'out' ? '↗️' : '↘️'}</td>
                <td style="font-size:0.75rem">${m.direction === 'out' ? 'Я' : (m.sender_name || '—')}</td>
                <td style="font-size:0.8rem">
                  ${m.media_type ? html`<span class="badge" style="font-size:0.65rem">${m.media_type}</span> ` : ''}
                  ${m.deleted_ts ? html`<em style="color:var(--mc-text-dim)">видалено</em>` : m.text}
                  ${m.edited_ts ? html`<span style="font-size:0.65rem;color:var(--mc-text-dim)"> (ред.)</span>` : ''}
                </td>
              </tr>`
          })}
        </tbody>
      </table>
    </div>`
}

/**
 * The instruction the answering agent is given for this chat.
 *
 * Lives on the chat page rather than in the list: it is a paragraph, not a
 * toggle, and it is the one control that decides how the bot sounds.
 */
function renderAutoReplyPanel(chat: TgChat) {
  return html`
    <div id="autoreply" class="card" style="margin:0.75rem 0;padding:0.75rem">
      <h3 style="margin:0 0 0.4rem;font-size:0.95rem">${icon('message-circle', 14)} Промт автовідповіді</h3>
      <p style="font-size:0.75rem;color:var(--mc-text-dim);margin:0 0 0.5rem">
        ${chat.auto_reply_bot
          ? html`Відповідає бот <code>${chat.auto_reply_bot}</code> через
                 ${chat.auto_reply_after_s < 90 ? `${chat.auto_reply_after_s} с` : `${Math.round(chat.auto_reply_after_s / 60)} хв`}
                 мовчання${chat.auto_reply_require_unread ? ', лише коли чат непрочитаний' : ''}.`
          : 'Автовідповідь для цього чату вимкнена — промт збережеться і застосується, коли ввімкнеш.'}
      </p>
      <div id="tg-autoreply-prompt">
        <form hx-post="/telegram/chat/${encodeURIComponent(chat.chat_id)}/auto-reply-prompt"
              hx-target="#tg-autoreply-prompt" hx-swap="innerHTML">
          <textarea name="prompt" rows="6" style="width:100%;font-size:0.8rem"
                    placeholder="Напр.: пиши коротко, українською, з гумором; на робочі питання відповідай стримано; ніколи не погоджуйся на зустрічі">${chat.auto_reply_prompt}</textarea>
          <div style="display:flex;gap:0.4rem;align-items:center;margin-top:0.4rem">
            <button class="btn-sm" type="submit">${icon('check', 11)} Зберегти</button>
            <span style="font-size:0.72rem;color:var(--mc-text-dim)">
              Порожньо — бот тримається твоєї манери за зразками з архіву.
            </span>
          </div>
        </form>
      </div>
      <p style="font-size:0.7rem;color:var(--mc-text-dim);margin:0.5rem 0 0">
        Межі не перевизначаються промтом: одне повідомлення, без вигаданих фактів про тебе,
        і право змовчати, якщо питання вимагає твого рішення.
      </p>
    </div>`
}

// --- Pages ---

app.get('/telegram', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')

  const content = html`
    <h1>${icon('send', 20)} Telegram Observer</h1>

    <div id="tg-status" hx-get="/telegram/status" hx-trigger="load, every 30s" hx-swap="innerHTML">
      <p style="color:var(--mc-text-dim)">Завантаження...</p>
    </div>

    <h2 style="margin-top:1.25rem">${icon('list', 16)} Чати</h2>
    ${chatFilters()}
    <div id="tg-chats" hx-get="/telegram/chats" hx-trigger="load" hx-swap="innerHTML">
      <p style="color:var(--mc-text-dim)">Завантаження...</p>
    </div>

    <h2 style="margin-top:1.25rem">${icon('message-square', 16)} Повідомлення</h2>
    <div style="display:flex;gap:0.4rem;margin-bottom:0.5rem;flex-wrap:wrap">
      <button class="btn-sm outline" hx-get="/telegram/messages?filter=all" hx-target="#tg-messages" hx-swap="innerHTML">Останні</button>
      <button class="btn-sm outline" hx-get="/telegram/messages?filter=in" hx-target="#tg-messages" hx-swap="innerHTML">Вхідні</button>
      <button class="btn-sm outline" hx-get="/telegram/messages?filter=out" hx-target="#tg-messages" hx-swap="innerHTML">Вихідні</button>
      <button class="btn-sm outline" hx-get="/telegram/messages?filter=unread" hx-target="#tg-messages" hx-swap="innerHTML">Непрочитані чати</button>
    </div>
    <div id="tg-messages" hx-get="/telegram/messages?filter=all" hx-trigger="load" hx-swap="innerHTML">
      <p style="color:var(--mc-text-dim)">Завантаження...</p>
    </div>

    <h2 style="margin-top:1.25rem">${icon('outdent', 16)} Вихідні дії ботів</h2>
    <div id="tg-outbox" hx-get="/telegram/outbox" hx-trigger="load" hx-swap="innerHTML">
      <p style="color:var(--mc-text-dim)">Завантаження...</p>
    </div>

    <h2 style="margin-top:1.25rem">${icon('file-text', 16)} Лог демона</h2>
    <div id="tg-log" hx-get="/telegram/log" hx-trigger="load, every 15s" hx-swap="innerHTML">
      <p style="color:var(--mc-text-dim)">Завантаження...</p>
    </div>

    ${guideBlock('Що це таке?', [
      'Telegram Observer — окремий демон, який тримає MTProto-сесію твого особистого акаунта (не бота).',
      'Він логує повідомлення за режимом кожного чату і віддає ботам MCP-інструменти через Unix socket store/telegram.sock.',
      'Боти можуть читати чати, бачити непрочитані і надсилати повідомлення від твого імені — відправка лише в чати з галочкою «Відправка».',
      'Витяг фактів і задач у пам\'ять бота — наступна фаза, зараз демон тільки логує.',
    ])}
  `

  return c.html(layout('Telegram', content, '/telegram', t, lang))
})

app.get('/telegram/chat/:id', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const chatId = decodeURIComponent(c.req.param('id'))
  const chat = getChat(chatId)

  if (!chat) return c.text('Чат не знайдено', 404)

  const messages = getMessages(chatId, 200).reverse()

  const content = html`
    <h1>${icon('message-square', 20)} ${chat.title}</h1>
    <p style="color:var(--mc-text-dim);font-size:0.8rem">
      ${kindBadge(chat.kind)} · <code>${chat.chat_id}</code>${chat.username ? html` · @${chat.username}` : ''}
      · режим ${modeBadge(chat.mode)}
      · відправка: ${chat.can_send ? 'дозволена' : 'заборонена'}
      · повідомлень у логу: ${messages.length}
    </p>
    <p><a href="/telegram" class="btn-sm outline">${icon('arrow-left', 11)} До списку</a></p>
    ${renderAutoReplyPanel(chat)}
    ${renderMessages(messages, false)}
  `

  return c.html(layout(`Telegram: ${chat.title}`, content, '/telegram', t, lang))
})

// --- Fragments (htmx) ---

app.get('/telegram/status', (c) => c.html(renderStatus(c.get('t'))))

app.get('/telegram/chats', (c) => {
  const q = parseChatQuery({
    page: c.req.query('page'),
    q: c.req.query('q'),
    // The filter bar sends list_mode; the pager rebuilds the URL with mode.
    mode: c.req.query('list_mode') ?? c.req.query('mode'),
    days: c.req.query('days'),
  })
  const opts = chatQueryToOptions(q)
  return c.html(renderChats(listChats(opts), q, countChats(opts), getBotNames()))
})

/** Re-render the chat list preserving whatever filters the form carried. */
function renderChatsFromBody(body: Record<string, unknown>) {
  const q = parseChatQuery({
    page: body['page'] ? String(body['page']) : undefined,
    q: body['q'] ? String(body['q']) : undefined,
    mode: body['list_mode'] ? String(body['list_mode']) : undefined,
    days: body['days'] ? String(body['days']) : undefined,
  })
  const opts = chatQueryToOptions(q)
  return renderChats(listChats(opts), q, countChats(opts), getBotNames())
}

app.get('/telegram/messages', (c) => {
  const filter = c.req.query('filter') ?? 'all'

  if (filter === 'unread') {
    const chats = listUnreadChats(50)
    if (chats.length === 0) {
      return c.html(html`<p style="color:var(--mc-text-dim);font-size:0.85rem">Непрочитаних немає.</p>`)
    }
    return c.html(html`
      <div class="table-wrap">
        <table>
          <thead><tr><th>Чат</th><th>Непрочитаних</th><th>Останнє</th></tr></thead>
          <tbody>
            ${chats.map(ch => html`
              <tr>
                <td><a href="/telegram/chat/${encodeURIComponent(ch.chat_id)}"><strong>${ch.title}</strong></a></td>
                <td><span class="badge">${ch.unread}</span></td>
                <td style="font-size:0.72rem;color:var(--mc-text-dim)">${ch.last_msg_ts ? fmtTime(ch.last_msg_ts) : '—'}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>`)
  }

  const direction = filter === 'in' ? 'in' : filter === 'out' ? 'out' : undefined
  return c.html(renderMessages(getRecentMessages(100, direction)))
})

app.get('/telegram/outbox', (c) => {
  const rows = listOutbox(50)
  if (rows.length === 0) {
    return c.html(html`<p style="color:var(--mc-text-dim);font-size:0.85rem">
      Ботів ще не просили нічого надсилати.
    </p>`)
  }
  return c.html(html`
    <div class="table-wrap">
      <table>
        <thead><tr><th>Час</th><th>Чат</th><th>Тип</th><th>Хто просив</th><th>Статус</th><th>Текст</th></tr></thead>
        <tbody>
          ${rows.map(o => {
            const chat = getChat(o.chat_id)
            return html`
              <tr>
                <td style="font-size:0.72rem;color:var(--mc-text-dim);white-space:nowrap">${fmtTime(o.created_at)}</td>
                <td style="font-size:0.75rem">${chat?.title ?? o.chat_id}</td>
                <td style="font-size:0.75rem">${o.kind}</td>
                <td style="font-size:0.75rem">${o.requested_by}</td>
                <td>${o.status === 'sent'
                  ? html`<span class="badge badge-set" style="font-size:0.65rem">надіслано</span>`
                  : o.status === 'skipped'
                    ? html`<span class="badge" style="font-size:0.65rem">змовчав</span>`
                    : html`<span class="badge badge-missing" style="font-size:0.65rem">помилка</span>`}</td>
                <td style="font-size:0.78rem">${o.text}${o.error ? html`<div style="font-size:0.7rem;color:${o.status === 'skipped' ? 'var(--mc-text-dim)' : 'var(--mc-error, #c00)'}">${o.error}</div>` : ''}</td>
              </tr>`
          })}
        </tbody>
      </table>
    </div>`)
})

app.get('/telegram/log', (c) => {
  const lines = readLogTail(60)
  if (lines.length === 0) {
    return c.html(html`<p style="color:var(--mc-text-dim);font-size:0.85rem">Лог порожній.</p>`)
  }
  return c.html(html`
    <pre style="max-height:320px;overflow:auto;font-size:0.72rem;padding:0.6rem;border:1px solid var(--mc-border);border-radius:8px;margin:0">${lines.join('\n')}</pre>`)
})

// --- Actions ---

app.post('/telegram/control/:action', async (c) => {
  const action = c.req.param('action')
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return c.text('Unknown action', 400)
  }
  await runControl(action)
  return c.html(renderStatus(c.get('t')))
})

app.post('/telegram/login/start', async (c) => {
  const body = await c.req.parseBody()
  const result = await startLogin(String(body['phone'] ?? ''))
  return c.html(html`${result.ok ? '' : html`<div class="alert alert-error">${result.error}</div>`}${renderStatus(c.get('t'))}`)
})

app.post('/telegram/login/code', async (c) => {
  const body = await c.req.parseBody()
  const result = await submitCode(String(body['code'] ?? ''))
  return c.html(html`${result.ok ? '' : html`<div class="alert alert-error">${result.error}</div>`}${renderStatus(c.get('t'))}`)
})

app.post('/telegram/login/password', async (c) => {
  const body = await c.req.parseBody()
  const result = await submitPassword(String(body['password'] ?? ''))
  return c.html(html`${result.ok ? '' : html`<div class="alert alert-error">${result.error}</div>`}${renderStatus(c.get('t'))}`)
})

app.post('/telegram/login/cancel', async (c) => {
  await cancelLogin()
  return c.html(renderStatus(c.get('t')))
})

app.post('/telegram/login/reset', async (c) => {
  await cancelLogin()
  const { unlinkSync, existsSync } = await import('fs')
  const { TG_SESSION_PATH } = await import('../../telegram/paths.js')
  if (existsSync(TG_SESSION_PATH)) {
    try { unlinkSync(TG_SESSION_PATH) } catch { /* ignore */ }
  }
  // The daemon holds the old session in memory; stop it so a restart picks up the change.
  await runControl('stop')
  return c.html(renderStatus(c.get('t')))
})

app.post('/telegram/purge-foreign', (c) => {
  const removed = purgeForeignRows()
  logger.info(`[telegram] purged foreign rows: ${removed.chats} chats, ${removed.messages} messages`)
  return c.html(renderStatus(c.get('t')))
})

app.post('/telegram/chat/:id/mode', async (c) => {
  const chatId = decodeURIComponent(c.req.param('id'))
  const body = await c.req.parseBody()
  const mode = String(body['mode'] ?? '') as ChatMode
  if (CHAT_MODES.includes(mode)) setChatMode(chatId, mode)
  return c.html(renderChatsFromBody(body))
})

/**
 * Update the unattended-reply policy for one chat.
 *
 * Each control posts only the field it changed, so the others are read back from
 * the row — a partial form must never silently reset the delay or the guard.
 */
app.post('/telegram/chat/:id/auto-reply', async (c) => {
  const chatId = decodeURIComponent(c.req.param('id'))
  const body = await c.req.parseBody()
  const current = getChat(chatId)
  if (!current) return c.html(renderChatsFromBody(body))

  const known = getBotNames()
  const rawBot = body['bot'] !== undefined ? String(body['bot']) : current.auto_reply_bot
  const bot = known.includes(rawBot) ? rawBot : ''

  // A group switched on for the first time defaults to mentions only. Answering
  // every message in a room full of people talking to each other is never what
  // the owner means, and it is the one mistake that cannot be taken back.
  const turningOn = !current.auto_reply_bot && !!bot
  const mentionOnly = body['mention_only'] !== undefined
    ? String(body['mention_only']) === '1'
    : (turningOn ? isGroupKind(current.kind) : !!current.auto_reply_mention_only)

  setAutoReply(chatId, {
    bot,
    afterSeconds: body['after_s'] !== undefined ? Number(body['after_s']) : current.auto_reply_after_s,
    requireUnread: body['require_unread'] !== undefined
      ? String(body['require_unread']) === '1'
      : !!current.auto_reply_require_unread,
    mentionOnly,
  })

  // Switching a chat on is the moment to give it a past.
  //
  // The log only holds what arrived since the observer started, and catch-up
  // deliberately visits just the thirty most recent chats of the last week — so
  // a quiet contact or a group further down the list has an empty archive, and
  // the first reply there would be composed with nothing to go on. Two bounded
  // requests, once, at the one point the owner has said this chat matters.
  if (turningOn) void seedChatArchive(chatId, current.title)

  logger.info({ chatId, bot, title: current.title }, '[telegram] auto-reply policy changed')
  return c.html(renderChatsFromBody(body))
})

app.post('/telegram/chat/:id/auto-reply-prompt', async (c) => {
  const chatId = decodeURIComponent(c.req.param('id'))
  const body = await c.req.parseBody()
  const prompt = String(body['prompt'] ?? '')
  setAutoReplyPrompt(chatId, prompt)
  logger.info({ chatId, chars: prompt.trim().length }, '[telegram] auto-reply prompt updated')

  return c.html(html`
    <form hx-post="/telegram/chat/${encodeURIComponent(chatId)}/auto-reply-prompt"
          hx-target="#tg-autoreply-prompt" hx-swap="innerHTML">
      <textarea name="prompt" rows="6" style="width:100%;font-size:0.8rem">${prompt.trim()}</textarea>
      <div style="display:flex;gap:0.4rem;align-items:center;margin-top:0.4rem">
        <button class="btn-sm" type="submit">${icon('check', 11)} Зберегти</button>
        <span style="font-size:0.72rem;color:var(--mc-success,#2a7)">Збережено. Застосується з наступної сесії чату.</span>
      </div>
    </form>`)
})

app.post('/telegram/chat/:id/can-send', async (c) => {
  const chatId = decodeURIComponent(c.req.param('id'))
  const body = await c.req.parseBody()
  setChatCanSend(chatId, String(body['can_send'] ?? '0') === '1')
  return c.html(renderChatsFromBody(body))
})

// JSON status for scripts and diagnostics
app.get('/telegram/api/status', (c) => {
  const s = getObserverStatus()
  return c.json({ ...s, counts: countMessages() })
})

export default app
