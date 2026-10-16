import { describe, it, expect, vi, beforeEach } from 'vitest'

const { STORE } = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  return { STORE: mkdtempSync(join(tmpdir(), 'secrets-ui-')) }
})

vi.mock('./config.js', () => ({ STORE_DIR: STORE, ALLOWED_CHAT_ID: '42,77' }))
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./tgap/registry.js', () => ({ getTgap: () => null }))

import { getDb } from './db.js'
import { secretsMiddleware, PROMPT_PREFIX, listView, _resetSecretsUiForTests } from './secrets-ui.js'
import { getSecretValues, putSecret, _resetSecretsForTests } from './secrets.js'

function fakeCtx(over: { from?: number; text?: string; replyTo?: { id: number; text: string } ; data?: string }) {
  const replies: Array<{ text: string; id: number }> = []
  const deleted: number[] = []
  const edits: Array<{ id: number; text: string }> = []
  let seq = 500
  const ctx: any = {
    chat: { id: over.from ?? 42, type: 'private' },
    from: { id: over.from ?? 42, is_bot: false },
    message: over.text !== undefined ? {
      message_id: 900, text: over.text,
      ...(over.replyTo ? { reply_to_message: { message_id: over.replyTo.id, text: over.replyTo.text, from: { is_bot: true } } } : {}),
    } : undefined,
    callbackQuery: over.data ? { data: over.data, message: { message_id: 333 } } : undefined,
    async reply(text: string) { const id = seq++; replies.push({ text, id }); return { message_id: id } },
    async answerCallbackQuery() {},
    api: {
      async deleteMessage(_c: number, id: number) { deleted.push(id) },
      async editMessageText(_c: number, id: number, text: string) { edits.push({ id, text }) },
    },
  }
  return { ctx, replies, deleted, edits }
}

beforeEach(() => {
  getDb().exec('DROP TABLE IF EXISTS secrets;')
  _resetSecretsForTests()
  _resetSecretsUiForTests()
})

describe('secretsMiddleware', () => {
  it('stores a value sent in reply to the prompt and deletes the message; the agent never sees it', async () => {
    const a = fakeCtx({ text: '/secret add bitrix Адмінка' })
    const next = vi.fn()
    await secretsMiddleware(a.ctx, next)
    const prompt = a.replies[0]
    expect(prompt.text.startsWith(PROMPT_PREFIX)).toBe(true)

    const b = fakeCtx({ text: 'login: admin\npassword: hunter2-long', replyTo: { id: prompt.id, text: prompt.text } })
    await secretsMiddleware(b.ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(b.deleted).toEqual([900])
    expect(getSecretValues('bitrix')).toEqual({ login: 'admin', password: 'hunter2-long' })
    expect(b.edits[0].text).toContain('Збережено «bitrix»')
    expect(b.edits[0].text).not.toContain('hunter2-long')
  })

  it('swallows and deletes a reply to a prompt it no longer remembers (after a restart)', async () => {
    const c = fakeCtx({ text: 'password: x', replyTo: { id: 123, text: `${PROMPT_PREFIX}old»: надішли значення` } })
    const next = vi.fn()
    await secretsMiddleware(c.ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(c.deleted).toEqual([900])
    expect(c.replies[0].text).toContain('застарів')
  })

  it('only the owner manages secrets; other allowed chats get nothing', async () => {
    const d = fakeCtx({ from: 77, text: '/secret' })
    const next = vi.fn()
    await secretsMiddleware(d.ctx, next)
    expect(d.replies).toHaveLength(0)
    expect(next).not.toHaveBeenCalled()
  })

  it('passes ordinary messages on', async () => {
    const e = fakeCtx({ text: 'привіт' })
    const next = vi.fn()
    await secretsMiddleware(e.ctx, next)
    expect(next).toHaveBeenCalled()
  })

  it('deletes after confirmation', async () => {
    putSecret('api', { value: 'sk-123456' })
    const f = fakeCtx({ data: 'sec:delok:api' })
    await secretsMiddleware(f.ctx, vi.fn())
    expect(getSecretValues('api')).toBeUndefined()
  })

  it('lists names and fields, never values; no share buttons with TGAP off', () => {
    putSecret('api', { value: 'sk-123456' })
    const v = listView()
    expect(v.html).toContain('<b>api</b>')
    expect(v.html).not.toContain('sk-123456')
    expect(v.keyboard.flat().map(b => (b as any).callback_data)).toEqual(['sec:del:api'])
  })
})
