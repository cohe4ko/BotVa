import { describe, it, expect, vi, beforeEach } from 'vitest'

const { STORE } = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  return { STORE: mkdtempSync(join(tmpdir(), 'secrets-store-')) }
})

vi.mock('./config.js', () => ({ STORE_DIR: STORE }))
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { getDb } from './db.js'
import {
  putSecret, getSecretValues, getSecretMeta, listSecrets, deleteSecret, freeName, parseSecretInput,
  resolvePlaceholders, redact, redactText, hasPlaceholder, boxKeys, seal, unseal, _resetSecretsForTests,
} from './secrets.js'
import { decideSecretInput, secretAllowedIn, secretInputHook, secretOutputHook } from './secret-hooks.js'

beforeEach(() => {
  getDb().exec('DROP TABLE IF EXISTS secrets;')
  _resetSecretsForTests()
})

describe('vault', () => {
  it('stores values encrypted and gives them back', () => {
    putSecret('Bitrix', { login: 'admin', password: 'hunter2-long' }, { note: 'site admin' })
    expect(getSecretValues('bitrix')).toEqual({ login: 'admin', password: 'hunter2-long' })
    expect(getSecretMeta('bitrix')).toMatchObject({ name: 'bitrix', fields: ['login', 'password'], note: 'site admin', source: null })
    const raw = JSON.stringify(getDb().prepare('SELECT * FROM secrets').all())
    expect(raw).not.toContain('hunter2-long')
  })

  it('keeps the master key private to its owner', () => {
    putSecret('x', { value: 'abcd' })
    expect(statSync(join(STORE, 'vault.key')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(STORE, 'vault.key'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects bad names', () => {
    expect(() => putSecret('has space', { value: 'x' })).toThrow()
    expect(() => putSecret('a'.repeat(25), { value: 'x' })).toThrow()
    expect(() => putSecret('ok', {})).toThrow()
  })

  it('forgets expired secrets', () => {
    putSecret('old', { value: 'abcdef' }, { expires_at: Math.floor(Date.now() / 1000) - 1 })
    expect(getSecretValues('old')).toBeUndefined()
    expect(listSecrets()).toHaveLength(0)
  })

  it('deletes', () => {
    putSecret('gone', { value: 'abcdef' })
    expect(deleteSecret('gone')).toBe(true)
    expect(getSecretValues('gone')).toBeUndefined()
  })

  it('finds a free name', () => {
    putSecret('site', { value: 'abcdef' })
    expect(freeName('site')).toBe('site-2')
    expect(freeName('other')).toBe('other')
  })
})

describe('parseSecretInput', () => {
  it('reads field: value lines', () => {
    expect(parseSecretInput('login: admin\npassword: p@ss:word')).toEqual({ login: 'admin', password: 'p@ss:word' })
  })

  it('takes a bare URL line as url', () => {
    expect(parseSecretInput('https://example.com/admin/\nlogin: a\npassword: b')).toEqual({ url: 'https://example.com/admin/', login: 'a', password: 'b' })
  })

  it('takes anything else as one value', () => {
    expect(parseSecretInput('sk-abc123 xyz')).toEqual({ value: 'sk-abc123 xyz' })
    expect(parseSecretInput('login: a\njust words')).toEqual({ value: 'login: a\njust words' })
  })
})

describe('placeholders', () => {
  beforeEach(() => putSecret('bitrix', { login: 'admin', password: 'hunter2-long' }))

  it('fills them in anywhere in a tool input', () => {
    const r = resolvePlaceholders({ command: 'login {{secret:bitrix.login}} {{secret:bitrix.password}}', nested: [{ v: '{{secret:BITRIX.password}}' }] })
    expect(r.value).toEqual({ command: 'login admin hunter2-long', nested: [{ v: 'hunter2-long' }] })
    expect(r.missing).toEqual([])
    expect(r.used.sort()).toEqual(['BITRIX.password', 'bitrix.login', 'bitrix.password'])
  })

  it('without a field: the only value, else value/password', () => {
    putSecret('key', { value: 'sk-123456' })
    expect(resolvePlaceholders('{{secret:key}}').value).toBe('sk-123456')
    expect(resolvePlaceholders('{{secret:bitrix}}').value).toBe('hunter2-long')
  })

  it('reports unknown ones', () => {
    expect(resolvePlaceholders('{{secret:nope.x}} {{secret:bitrix.otp}}').missing).toEqual(['{{secret:nope.x}}', '{{secret:bitrix.otp}}'])
  })

  it('redacts values back to placeholders', () => {
    // the login is an ordinary word ("/bitrix/admin/"): left as it is
    expect(redact({ out: 'user admin pass hunter2-long' })).toEqual({ out: 'user admin pass {{secret:bitrix.password}}' })
    expect(redact('nothing here')).toBeNull()
    expect(redactText('x hunter2-long y')).toBe('x {{secret:bitrix.password}} y')
  })

  it('detects placeholders', () => {
    expect(hasPlaceholder({ a: ['{{secret:bitrix.login}}'] })).toBe(true)
    expect(hasPlaceholder({ a: '{{secret}}' })).toBe(false)
  })
})

describe('sealing', () => {
  it('only this bot can open what is sealed to it, and only for the same envelope', () => {
    const { publicKey } = boxKeys()
    expect(boxKeys().publicKey).toBe(publicKey)
    const s = seal(publicKey, '{"password":"x"}', 'ENV1|bitrix')
    expect(JSON.stringify(s)).not.toContain('password')
    expect(unseal(s, 'ENV1|bitrix')).toBe('{"password":"x"}')
    expect(() => unseal(s, 'ENV2|bitrix')).toThrow()
    expect(() => unseal({ ...s, ct: Buffer.from('tampered').toString('base64') }, 'ENV1|bitrix')).toThrow()
  })
})

describe('secret hooks', () => {
  beforeEach(() => putSecret('bitrix', { login: 'admin', password: 'hunter2-long' }))

  it('fills in a login form', () => {
    const d = decideSecretInput('mcp__playwright__browser_type', { ref: 'e1', text: '{{secret:bitrix.password}}' }, false)
    expect(d).toEqual({ kind: 'replace', input: { ref: 'e1', text: 'hunter2-long' }, used: ['bitrix.password'] })
  })

  it('refuses tools that would carry the value away', () => {
    expect(secretAllowedIn('mcp__builtin__SendEmail')).toBe(false)
    expect(secretAllowedIn('mcp__builtin__AskExternalBot')).toBe(false)
    expect(secretAllowedIn('mcp__telegram__tg_send_message')).toBe(false)
    expect(secretAllowedIn('WebFetch')).toBe(false)
    expect(secretAllowedIn('Bash')).toBe(true)
    expect(decideSecretInput('mcp__builtin__SaveFact', { text: '{{secret:bitrix.password}}' }, false).kind).toBe('block')
  })

  it('refuses in ask mode and for unknown names', () => {
    expect(decideSecretInput('Bash', { command: 'echo {{secret:bitrix.password}}' }, true).kind).toBe('block')
    const d = decideSecretInput('Bash', { command: 'echo {{secret:other}}' }, false)
    expect(d.kind === 'block' && d.reason).toContain('bitrix (login, password)')
  })

  it('leaves calls without placeholders alone', async () => {
    expect(await secretInputHook(false)({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({})
  })

  it('hook output has the shape the SDK expects', async () => {
    const pre = await secretInputHook(false)({ tool_name: 'Bash', tool_input: { command: 'x {{secret:bitrix.login}}' } }) as any
    expect(pre.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'x admin' } })
    const post = await secretOutputHook()({ tool_response: { stdout: 'pw hunter2-long' } }) as any
    expect(post.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', updatedToolOutput: { stdout: 'pw {{secret:bitrix.password}}' } })
    expect(await secretOutputHook()({ tool_response: { stdout: 'clean' } })).toEqual({})
  })
})
