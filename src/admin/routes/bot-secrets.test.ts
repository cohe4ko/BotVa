import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ROOT } = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  const root = mkdtempSync(join(tmpdir(), 'admin-secrets-'))
  mkdirSync(join(root, 'bots', 'demo', 'store'), { recursive: true })
  return { ROOT: root }
})

vi.mock('../../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../db-multi.js', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { join } = await import('node:path')
  let db: InstanceType<typeof DatabaseSync> | null = null
  return {
    getBotNames: () => ['demo'],
    getBotDir: (n: string) => join(ROOT, 'bots', n),
    getBotDb: () => (db ??= new DatabaseSync(join(ROOT, 'bots', 'demo', 'store', 'botva.db'))),
  }
})
vi.mock('../../chrome-import.js', async (orig) => ({
  ...(await orig<typeof import('../../chrome-import.js')>()),
  chromeAvailable: () => true,
  listChromeLogins: () => [
    { profile: 'Default', rowid: 1, origin: 'https://www.shop.com.ua/admin/', username: 'admin', lastUsed: 1_700_000_000 },
    { profile: 'Default', rowid: 2, origin: 'https://github.com/login', username: 'dev', lastUsed: 0 },
  ],
  readChromeLogin: vi.fn(async (_p: string, rowid: number) =>
    rowid === 1 ? { url: 'https://www.shop.com.ua/admin/', login: 'admin', password: 'very-secret-pw' }
                : { url: 'https://github.com/login', login: 'dev', password: 'gh-secret-pw' }),
}))

import { Hono } from 'hono'
import { join } from 'node:path'
import { createT, type I18nEnv } from '../i18n.js'
import route, { filterLogins } from './bot-secrets.js'
import { getBotDb } from '../db-multi.js'
import { readAllValues, vaultKey, writeSecret, ensureVaultSchema } from '../../vault-core.js'

const app = new Hono<I18nEnv>()
app.use('*', async (c, next) => { c.set('t', createT('uk')); c.set('lang', 'uk'); await next() })
app.route('/', route)

const STORE = join(ROOT, 'bots', 'demo', 'store')
const form = (o: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(o), headers: { 'content-type': 'application/x-www-form-urlencoded' } })

beforeEach(() => {
  const d = getBotDb('demo')
  ensureVaultSchema(d)
  d.exec('DELETE FROM secrets')
})

describe('admin: secrets', () => {
  it('lists names and fields, never values', async () => {
    writeSecret(getBotDb('demo'), vaultKey(STORE), 'api', { token: 'tok-123456' }, { note: 'test' })
    const page = await (await app.request('/bot/demo/secrets')).text()
    expect(page).toContain('<code>api</code>')
    expect(page).toContain('<code>token</code>')
    expect(page).not.toContain('tok-123456')
  })

  it('lists Chrome logins with a suggested name and no passwords', async () => {
    const html = await (await app.request('/bot/demo/secrets/chrome?q=shop')).text()
    expect(html).toContain('www.shop.com.ua/admin')
    expect(html).toContain('value="shop"')
    expect(html).not.toContain('github')
    expect(html).not.toContain('very-secret-pw')
  })

  it('imports a login into the bot vault without putting the password on the page', async () => {
    const res = await (await app.request('/bot/demo/secrets/import', form({ profile: 'Default', rowid: '1', secret: 'shop' }))).text()
    expect(res).toContain('Збережено')
    expect(res).not.toContain('very-secret-pw')
    expect(readAllValues(getBotDb('demo'), vaultKey(STORE)).get('shop')).toEqual({ url: 'https://www.shop.com.ua/admin/', login: 'admin', password: 'very-secret-pw' })
    const again = await (await app.request('/bot/demo/secrets/chrome?q=shop')).text()
    expect(again).toContain('Оновити')
  })

  it('asks before replacing a secret that came from elsewhere', async () => {
    writeSecret(getBotDb('demo'), vaultKey(STORE), 'shop', { value: 'manual-value' })
    const res = await (await app.request('/bot/demo/secrets/import', form({ profile: 'Default', rowid: '2', secret: 'shop' }))).text()
    expect(res).toContain('Замінити')
    expect(readAllValues(getBotDb('demo'), vaultKey(STORE)).get('shop')).toEqual({ value: 'manual-value' })
    await app.request('/bot/demo/secrets/import', form({ profile: 'Default', rowid: '2', secret: 'shop', replace: '1' }))
    expect(readAllValues(getBotDb('demo'), vaultKey(STORE)).get('shop')?.login).toBe('dev')
  })

  it('refuses a bad name and deletes on request', async () => {
    expect(await (await app.request('/bot/demo/secrets/import', form({ profile: 'Default', rowid: '1', secret: '-bad name' }))).text()).toContain('Назва')
    writeSecret(getBotDb('demo'), vaultKey(STORE), 'old', { value: 'abcdef' })
    await app.request('/bot/demo/secrets/old', { method: 'DELETE' })
    expect(readAllValues(getBotDb('demo'), vaultKey(STORE)).has('old')).toBe(false)
  })

  it('filters by site or login', () => {
    const all = [
      { profile: 'Default', rowid: 1, origin: 'https://a.com/', username: 'root', lastUsed: 0 },
      { profile: 'Default', rowid: 2, origin: 'https://b.com/', username: 'admin', lastUsed: 0 },
    ]
    expect(filterLogins(all, 'B.COM').map(l => l.rowid)).toEqual([2])
    expect(filterLogins(all, 'root').map(l => l.rowid)).toEqual([1])
    expect(filterLogins(all, '  ')).toHaveLength(2)
  })
})
