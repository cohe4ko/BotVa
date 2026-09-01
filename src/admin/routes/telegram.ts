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
import { getProjectRoot } from '../db-multi.js'
import { execFile } from 'child_process'
import { join } from 'path'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { getObserverStatus, readLogTail } from '../../telegram/status.js'
import {
  listChats, listUnreadChats, getRecentMessages, getMessages, listOutbox,
  setChatMode, setChatCanSend, getChat, countMessages,
  type ChatMode, type TgMessage, type TgChat,
} from '../../telegram/db.js'
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

function renderChats(chats: TgChat[]) {
  if (chats.length === 0) {
    return html`<p style="color:var(--mc-text-dim);font-size:0.85rem">
      Чатів ще немає. Вони з'являться після запуску демона і перших повідомлень.
    </p>`
  }

  return html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Чат</th><th>Тип</th><th>Непрочитані</th><th>Режим</th><th>Відправка</th><th>Останнє</th><th></th></tr>
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
                        hx-vals="js:{mode: event.target.value}" hx-trigger="change">
                  ${CHAT_MODES.map(m => html`<option value="${m}"${m === c.mode ? ' selected' : ''}>${m}</option>`)}
                </select>
              </td>
              <td>
                <input type="checkbox" style="margin:0"${c.can_send ? ' checked' : ''}
                       hx-post="/telegram/chat/${encodeURIComponent(c.chat_id)}/can-send"
                       hx-target="#tg-chats" hx-swap="innerHTML"
                       hx-vals="js:{can_send: event.target.checked ? '1' : '0'}" hx-trigger="change">
              </td>
              <td style="font-size:0.72rem;color:var(--mc-text-dim)">${c.last_msg_ts ? fmtTime(c.last_msg_ts) : '—'}</td>
              <td>${modeBadge(c.mode)}</td>
            </tr>`)}
        </tbody>
      </table>
    </div>
    <p style="font-size:0.72rem;color:var(--mc-text-dim);margin-top:0.4rem">
      ${CHAT_MODES.map(m => html`<code>${m}</code> — ${MODE_HINT[m]}. `)}
      Боти завжди <code>ignore</code> за замовчуванням, щоб бот BotVa не читав власні повідомлення.
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
    ${renderMessages(messages, false)}
  `

  return c.html(layout(`Telegram: ${chat.title}`, content, '/telegram', t, lang))
})

// --- Fragments (htmx) ---

app.get('/telegram/status', (c) => c.html(renderStatus(c.get('t'))))

app.get('/telegram/chats', (c) => c.html(renderChats(listChats({ limit: 200 }))))

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
                  : html`<span class="badge badge-missing" style="font-size:0.65rem">помилка</span>`}</td>
                <td style="font-size:0.78rem">${o.text}${o.error ? html`<div style="font-size:0.7rem;color:var(--mc-error, #c00)">${o.error}</div>` : ''}</td>
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

app.post('/telegram/chat/:id/mode', async (c) => {
  const chatId = decodeURIComponent(c.req.param('id'))
  const body = await c.req.parseBody()
  const mode = String(body['mode'] ?? '') as ChatMode
  if (CHAT_MODES.includes(mode)) setChatMode(chatId, mode)
  return c.html(renderChats(listChats({ limit: 200 })))
})

app.post('/telegram/chat/:id/can-send', async (c) => {
  const chatId = decodeURIComponent(c.req.param('id'))
  const body = await c.req.parseBody()
  setChatCanSend(chatId, String(body['can_send'] ?? '0') === '1')
  return c.html(renderChats(listChats({ limit: 200 })))
})

// JSON status for scripts and diagnostics
app.get('/telegram/api/status', (c) => {
  const s = getObserverStatus()
  return c.json({ ...s, counts: countMessages() })
})

export default app
