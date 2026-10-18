import { describe, it, expect } from 'vitest'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decryptChromeValue, findChromeLogins, listChromeLogins, siteKey, suggestName } from './chrome-import.js'

const key = pbkdf2Sync('test-pass', 'saltysalt', 1003, 16, 'sha1')

function encrypt(plain: string): Buffer {
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), c.update(plain, 'utf8'), c.final()])
}

function fakeChrome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-fake-'))
  const add = (profile: string, rows: Array<[string, string, string, number?]>) => {
    mkdirSync(join(dir, profile))
    const db = new DatabaseSync(join(dir, profile, 'Login Data'))
    db.exec('CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, date_last_used INTEGER)')
    const ins = db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?, 0)')
    for (const [o, u, p, bl = 0] of rows) ins.run(o, u, p ? encrypt(p) : Buffer.alloc(0), bl)
    db.close()
  }
  add('Default', [['https://other.com/', 'x', 'y']])
  add('Profile 1', [
    ['https://www.shop.com.ua/bitrix/admin/index.php', 'admin', 's3cret'],
    ['http://shop.com.ua/bitrix/admin/index.php', 'admin', 's3cret'],
    ['https://crm.shop.com.ua/', 'manager', 'p2'],
    ['https://notshop.com.ua/', 'z', 'z'],
    ['https://shop.com.ua/never', 'n', '', 0],
    ['https://shop.com.ua/blocked', 'b', 'b', 1],
  ])
  mkdirSync(join(dir, 'System Profile'))
  return dir
}

describe('chrome-import', () => {
  it('siteKey takes the host without www', () => {
    expect(siteKey('https://www.Shop.com.ua/bitrix/admin/')).toBe('shop.com.ua')
    expect(siteKey('shop.com.ua/bitrix')).toBe('shop.com.ua')
  })

  it('finds logins for a host and its subdomains, one per host and user (www folded), without passwords', () => {
    const found = findChromeLogins('shop.com.ua', fakeChrome())
    expect(found.map(f => `${f.username}@${f.origin}`)).toEqual([
      'admin@https://www.shop.com.ua/bitrix/admin/index.php',
      'manager@https://crm.shop.com.ua/',
    ])
    expect(JSON.stringify(found)).not.toContain('s3cret')
  })

  it('a path narrows the match', () => {
    const found = findChromeLogins('https://shop.com.ua/bitrix/admin/', fakeChrome())
    expect(found.map(f => f.username)).toEqual(['admin'])
  })

  it('nothing for an unknown site or a missing Chrome', () => {
    expect(findChromeLogins('example.org', fakeChrome())).toEqual([])
    expect(findChromeLogins('shop.com.ua', join(tmpdir(), 'no-chrome-here'))).toEqual([])
  })

  it('decrypts a v10 value and refuses other formats', () => {
    expect(decryptChromeValue(encrypt('pa$$ wörd'), key)).toBe('pa$$ wörd')
    expect(() => decryptChromeValue(Buffer.from('v11abc'), key)).toThrow(/формат/)
  })

  it('lists every login with a password across profiles, without passwords', () => {
    const all = listChromeLogins(fakeChrome())
    expect(all.map(l => l.username).sort()).toEqual(['admin', 'manager', 'x', 'z'])
    expect(all.every(l => l.profile && l.rowid > 0)).toBe(true)
    expect(JSON.stringify(all)).not.toContain('s3cret')
  })

  it('suggests a vault name from the URL', () => {
    expect(suggestName('https://www.shop.com.ua/bitrix/admin/')).toBe('shop')
    expect(suggestName('https://crm.shop.com.ua/')).toBe('shop-crm')
    expect(suggestName('https://github.com/login')).toBe('github')
    expect(suggestName('http://192.168.1.10:8123/')).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
  })
})
