/**
 * The bot's vault in the admin panel: names and fields of its secrets (never
 * values), what it shared over TGAP, and logins saved in Google Chrome on this
 * Mac to import. An import goes from Chrome straight into the bot's vault;
 * the password is never put on the page.
 */

import { Hono } from 'hono'
import { html } from 'hono/html'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { layout, botNav } from '../views/layout.js'
import { alert, formatTs } from '../views/components.js'
import { getBotDb, getBotDir } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import {
  ensureVaultSchema, vaultKey, writeSecret, readSecretList, readSecretMeta, removeSecret, dropExpiredSecrets,
  normalizeName, SECRET_NAME, type SecretMeta,
} from '../../vault-core.js'
import { chromeAvailable, listChromeLogins, readChromeLogin, siteKey, suggestName, type ChromeLogin } from '../../chrome-import.js'
import { logger } from '../../logger.js'

const app = new Hono<I18nEnv>()

/** A note that marks a secret as imported from this Chrome URL. */
export const chromeNote = (url: string) => `з Chrome: ${url}`

const icon = (name: string) => html`<i data-lucide="${name}" style="width:13px;height:13px;display:inline-block;vertical-align:middle"></i>`

function vault(bot: string): DatabaseSync {
  const d = getBotDb(bot)
  ensureVaultSchema(d)
  dropExpiredSecrets(d)
  return d
}

const storeDir = (bot: string) => resolve(getBotDir(bot), 'store')

interface ShareView { id: string; direction: string; name: string; state: string; peer: string; updated_at: number }

function shares(d: DatabaseSync): ShareView[] {
  try {
    return d.prepare(`
      SELECT s.id, s.direction, s.name, s.state, s.updated_at,
             COALESCE('@' || p.username, CAST(s.peer_id AS TEXT)) AS peer
      FROM tgap_secret_shares s LEFT JOIN tgap_peers p ON p.bot_id = s.peer_id
      ORDER BY s.updated_at DESC LIMIT 50
    `).all() as unknown as ShareView[]
  } catch { return [] /* TGAP never ran on this bot */ }
}

function secretRow(bot: string, s: SecretMeta, t: TFunc) {
  return html`
    <tr id="secret-${s.name}">
      <td><code>${s.name}</code></td>
      <td style="font-size:0.78rem">${s.fields.map(f => html`<code>${f}</code> `)}</td>
      <td style="font-size:0.78rem">${s.note ?? ''}${s.source ? html`<br><small>${t('secrets.from')} ${s.source}</small>` : ''}</td>
      <td class="ts-cell hide-mobile">${s.expires_at ? formatTs(s.expires_at) : t('secrets.forever')}</td>
      <td class="ts-cell hide-mobile">${formatTs(s.created_at)}</td>
      <td><button hx-delete="/bot/${bot}/secrets/${s.name}" hx-target="#secret-${s.name}" hx-swap="outerHTML" hx-confirm="${t('secrets.deleteConfirm', { name: s.name })}" class="danger btn-sm">${icon('trash-2')}</button></td>
    </tr>`
}

app.get('/bot/:name/secrets', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  let list: SecretMeta[] = []
  let shared: ShareView[] = []
  try { const d = vault(name); list = readSecretList(d); shared = shares(d) } catch { /* no database yet */ }

  const content = html`
    ${botNav(name, 'secrets', t)}
    <p style="font-size:0.8rem;opacity:0.8">${t('secrets.intro')}</p>

    <div class="section-header">
      <h3 style="margin:0">${icon('key-round')} ${t('secrets.vault')}</h3>
      <small>${list.length}</small>
    </div>
    ${list.length === 0
      ? html`<div class="empty-state" style="margin-bottom:2rem"><p>${t('secrets.empty')}</p></div>`
      : html`
        <div class="table-wrap" style="margin-bottom:2rem"><table>
          <thead><tr><th>${t('secrets.name')}</th><th>${t('secrets.fields')}</th><th>${t('secrets.note')}</th><th class="hide-mobile">${t('secrets.expires')}</th><th class="hide-mobile">${t('common.created')}</th><th style="width:50px"></th></tr></thead>
          <tbody>${list.map(s => secretRow(name, s, t))}</tbody>
        </table></div>`}

    ${shared.length > 0 ? html`
      <div class="section-header">
        <h3 style="margin:0">${icon('send')} ${t('secrets.shares')}</h3>
        <small>${t('secrets.sharesHint')}</small>
      </div>
      <div class="table-wrap" style="margin-bottom:2rem"><table>
        <thead><tr><th></th><th>${t('secrets.name')}</th><th>${t('secrets.peer')}</th><th>${t('secrets.state')}</th><th class="hide-mobile">${t('secrets.updated')}</th></tr></thead>
        <tbody>${shared.map(s => html`
          <tr><td>${s.direction === 'out' ? '→' : '←'}</td><td><code>${s.name}</code></td><td>${s.peer}</td><td><small>${t(`secrets.state.${s.state}`)}</small></td><td class="ts-cell hide-mobile">${formatTs(s.updated_at)}</td></tr>`)}
        </tbody>
      </table></div>` : ''}

    <div class="section-header">
      <h3 style="margin:0">${icon('globe')} ${t('secrets.chrome')}</h3>
    </div>
    ${chromeAvailable()
      ? html`
        <p style="font-size:0.8rem;opacity:0.8">${t('secrets.chromeHint')}</p>
        <div id="chrome-alerts"></div>
        <input type="search" name="q" placeholder="${t('secrets.chromeSearch')}"
          hx-get="/bot/${name}/secrets/chrome" hx-trigger="load, input changed delay:300ms, search" hx-target="#chrome-list">
        <div id="chrome-list" aria-busy="true"></div>`
      : html`<div class="empty-state"><p>${t('secrets.chromeMissing')}</p></div>`}
  `
  return c.html(layout(`${name} ${t('botnav.secrets')}`, content, `/bot/${name}/secrets`, t, lang))
})

/** Which secret, if any, was imported from this Chrome login. */
function importedAs(list: SecretMeta[], l: ChromeLogin): string | undefined {
  return list.find(s => s.note === chromeNote(l.origin))?.name
}

/** Logins matching `q` in the URL or the username. */
export function filterLogins(all: ChromeLogin[], q: string): ChromeLogin[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return all
  return all.filter(l => l.origin.toLowerCase().includes(needle) || l.username.toLowerCase().includes(needle))
}

const LIMIT = 100

app.get('/bot/:name/secrets/chrome', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  let all: ChromeLogin[]
  try { all = listChromeLogins() } catch (err: any) { return c.html(alert('error', `${t('secrets.chromeError')}: ${err?.message ?? err}`)) }
  const found = filterLogins(all, c.req.query('q') ?? '')
  let list: SecretMeta[] = []
  try { list = readSecretList(vault(name)) } catch { /* no database yet */ }
  if (found.length === 0) return c.html(html`<div class="empty-state"><p>${t('secrets.chromeNone')}</p></div>`)
  return c.html(html`
    <small>${t('secrets.chromeCount', { shown: Math.min(found.length, LIMIT), total: found.length })}</small>
    <div class="table-wrap"><table>
      <thead><tr><th>${t('secrets.site')}</th><th>${t('secrets.login')}</th><th class="hide-mobile">${t('secrets.lastUsed')}</th><th>${t('secrets.saveAs')}</th></tr></thead>
      <tbody>${found.slice(0, LIMIT).map((l, i) => {
        const done = importedAs(list, l)
        const where = l.origin.replace(/^https?:\/\//, '').replace(/\/$/, '')
        return html`
        <tr>
          <td style="font-size:0.78rem;word-break:break-all" title="${l.origin}">${where}${l.profile !== 'Default' ? html`<br><small>${l.profile}</small>` : ''}</td>
          <td style="font-size:0.78rem">${l.username || html`<i>${t('secrets.noLogin')}</i>`}</td>
          <td class="ts-cell hide-mobile">${l.lastUsed ? formatTs(l.lastUsed) : '—'}</td>
          <td id="imp-${i}">
            <form hx-post="/bot/${name}/secrets/import" hx-target="#imp-${i}" hx-swap="innerHTML" style="display:flex;gap:0.35rem;margin:0">
              <input type="hidden" name="profile" value="${l.profile}">
              <input type="hidden" name="rowid" value="${l.rowid}">
              <input type="text" name="secret" value="${done ?? suggestName(l.origin)}" pattern="[a-z0-9][a-z0-9_\\-]{0,23}" required style="margin:0;min-width:7rem;font-size:0.78rem;padding:0.25rem 0.4rem">
              <button type="submit" class="btn-sm${done ? ' outline' : ''}" style="margin:0;white-space:nowrap">${done ? html`${icon('refresh-cw')} ${t('secrets.reimport')}` : html`${icon('download')} ${t('secrets.import')}`}</button>
            </form>
          </td>
        </tr>`
      })}</tbody>
    </table></div>
  `)
})

app.post('/bot/:name/secrets/import', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const bot = botName(c)
  const body = await c.req.parseBody()
  const profile = String(body['profile'] ?? '')
  const rowid = Number(body['rowid'])
  const secret = normalizeName(String(body['secret'] ?? ''))
  const replace = body['replace'] === '1'
  if (!SECRET_NAME.test(secret)) return c.html(alert('error', t('secrets.badName')))
  if (!profile || !Number.isInteger(rowid)) return c.html(alert('error', t('secrets.chromeGone')))
  try {
    const d = vault(bot)
    const existing = readSecretMeta(d, secret)
    const values = await readChromeLogin(profile, rowid)
    const note = chromeNote(values.url)
    if (existing && existing.note !== note && !replace) {
      return c.html(html`
        ${alert('warning', t('secrets.exists', { name: secret }))}
        <button class="danger btn-sm" hx-post="/bot/${bot}/secrets/import" hx-target="closest td" hx-swap="innerHTML"
          hx-vals='${JSON.stringify({ profile, rowid: String(rowid), secret, replace: '1' })}'>${t('secrets.replace')}</button>`)
    }
    writeSecret(d, vaultKey(storeDir(bot)), secret, values, { note })
    logger.info({ bot, name: secret, host: siteKey(values.url) }, '[admin] imported a Chrome login into the vault')
    return c.html(alert('success', t('secrets.imported', { name: secret })))
  } catch (err: any) {
    return c.html(alert('error', `${t('secrets.chromeError')}: ${err?.message ?? err}`))
  }
})

app.delete('/bot/:name/secrets/:secret', validateBot, (c) => {
  const bot = botName(c)
  try { removeSecret(vault(bot), c.req.param('secret')!) } catch { /* already gone */ }
  return c.html(html``)
})

export default app
