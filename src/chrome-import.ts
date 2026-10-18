/**
 * Logins saved in Google Chrome on this Mac, straight into the vault.
 *
 * The agent asks for a site; the owner picks the login by a button; the bot
 * process decrypts Chrome's password and hands it to putSecret(). The value
 * never passes through the model, the chat or Telegram's servers, which is
 * safer than typing it into /secret add.
 *
 * Chrome on macOS keeps passwords in "<profile>/Login Data" (SQLite),
 * AES-128-CBC under a key derived (PBKDF2-SHA1, "saltysalt", 1003 rounds)
 * from the "Chrome Safe Storage" Keychain item. Values start with "v10".
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ChromeLogin {
  profile: string
  rowid: number
  origin: string
  username: string
  /** Unix seconds, 0 if Chrome never recorded a use. */
  lastUsed: number
}

export function chromeDir(): string {
  return process.env.CHROME_USER_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
}

function profiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(p => (p === 'Default' || /^Profile \d+$/.test(p)) && existsSync(join(dir, p, 'Login Data')))
}

/** Chrome holds a lock on the file while running, so read a copy. */
function withCopy<T>(file: string, f: (db: DatabaseSync) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'botva-chrome-'))
  try {
    const copy = join(tmp, 'ld.db')
    copyFileSync(file, copy)
    const db = new DatabaseSync(copy, { readOnly: true })
    try { return f(db) } finally { db.close() }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Host of a URL or a bare "example.com"; lower case, no www. */
export function siteKey(s: string): string {
  let h = s.trim().toLowerCase()
  try { h = new URL(/^[a-z]+:\/\//.test(h) ? h : `https://${h}`).hostname } catch { /* keep as typed */ }
  return h.replace(/^www\./, '')
}

/** Chrome counts microseconds from 1601-01-01. */
const WEBKIT_EPOCH_S = 11_644_473_600

/** Every login with a saved password, newest use first, one per host and username. Usernames and URLs only. */
export function listChromeLogins(dir = chromeDir()): ChromeLogin[] {
  const out: ChromeLogin[] = []
  const seen = new Set<string>()
  for (const profile of profiles(dir)) {
    const rows = withCopy(join(dir, profile, 'Login Data'), db =>
      db.prepare(`SELECT rowid AS rid, origin_url, username_value, date_last_used FROM logins WHERE blacklisted_by_user = 0 AND length(password_value) > 0 ORDER BY date_last_used DESC`).all() as Array<{ rid: number; origin_url: string; username_value: string; date_last_used: number | bigint | null }>)
    for (const r of rows) {
      const key = `${siteKey(r.origin_url)}|${r.username_value}`
      if (seen.has(key)) continue
      seen.add(key)
      const used = Number(r.date_last_used ?? 0)
      out.push({ profile, rowid: Number(r.rid), origin: r.origin_url, username: r.username_value, lastUsed: used > 0 ? Math.max(0, Math.floor(used / 1e6) - WEBKIT_EPOCH_S) : 0 })
    }
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed)
}

/** Saved logins whose host is the site or its subdomain. Usernames and URLs only. */
export function findChromeLogins(site: string, dir = chromeDir()): ChromeLogin[] {
  const want = siteKey(site)
  if (!want) return []
  // "example.com/bitrix/admin" narrows to logins saved on that path
  const bare = site.trim().replace(/^[a-z]+:\/\//i, '')
  const slash = bare.indexOf('/')
  const path = slash > 0 ? bare.slice(slash).replace(/\/+$/, '').toLowerCase() : ''
  return listChromeLogins(dir).filter(l => {
    const host = siteKey(l.origin)
    if (host !== want && !host.endsWith(`.${want}`)) return false
    return !path || l.origin.toLowerCase().includes(path)
  })
}

/** Chrome is installed with at least one profile that keeps passwords. */
export function chromeAvailable(dir = chromeDir()): boolean {
  return process.platform === 'darwin' && profiles(dir).length > 0
}

/** A vault name suggested by a login's URL: "crm.example.com" → "example-crm". */
export function suggestName(origin: string): string {
  const parts = siteKey(origin).split('.').filter(Boolean)
  if (parts.length > 1) parts.pop()
  // Second-level zones like com.ua, co.uk
  if (parts.length > 1 && ['com', 'co', 'org', 'net', 'gov', 'edu', 'ac', 'in'].includes(parts.at(-1)!)) parts.pop()
  const main = parts.pop() ?? 'login'
  const base = [main, ...parts.filter(p => p !== 'www')].join('-').replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (/^[a-z0-9]/.test(base) ? base : 'login').slice(0, 24)
}

let keyCache: Buffer | null = null

async function chromeKey(): Promise<Buffer> {
  if (keyCache) return keyCache
  if (process.platform !== 'darwin') throw new Error('Імпорт з Chrome працює лише на macOS')
  let pass: string
  try {
    const { stdout } = await run('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { timeout: 20_000 })
    pass = stdout.trim()
  } catch {
    throw new Error('Немає доступу до ключа Chrome у Keychain (Chrome Safe Storage)')
  }
  keyCache = pbkdf2Sync(pass, 'saltysalt', 1003, 16, 'sha1')
  return keyCache
}

export function decryptChromeValue(blob: Uint8Array, key: Buffer): string {
  const buf = Buffer.from(blob)
  const prefix = buf.subarray(0, 3).toString()
  if (prefix !== 'v10') throw new Error(`Невідомий формат шифрування Chrome (${prefix || 'порожньо'})`)
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([d.update(buf.subarray(3)), d.final()]).toString('utf8')
}

/** The login, password and URL of one saved login. Only for putSecret(): never log or return it to the agent. */
export async function readChromeLogin(profile: string, rowid: number, dir = chromeDir()): Promise<{ url: string; login: string; password: string }> {
  if (!profiles(dir).includes(profile)) throw new Error(`Немає профілю Chrome «${profile}»`)
  const row = withCopy(join(dir, profile, 'Login Data'), db =>
    db.prepare('SELECT origin_url, username_value, password_value FROM logins WHERE rowid = ?').get(rowid) as
      { origin_url: string; username_value: string; password_value: Uint8Array } | undefined)
  if (!row) throw new Error('Цього логіна в Chrome уже немає')
  const password = decryptChromeValue(row.password_value, await chromeKey())
  return { url: row.origin_url, login: row.username_value, password }
}
