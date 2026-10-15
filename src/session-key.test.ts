import { describe, it, expect, vi } from 'vitest'

const settings = new Map<string, string>()
vi.mock('./db.js', () => ({ getChatSetting: (chat: string, key: string) => settings.get(`${chat}:${key}`) }))

import { sessionKey, chatOfKey, threadOf, keyOf, getSessionMode, routeIntoThread } from './session-key.js'

const privateCtx = (thread?: number, chatId = 5) => ({
  chat: { id: chatId, type: 'private' },
  msg: thread ? { message_thread_id: thread, is_topic_message: true } : {},
}) as any

describe('session keys', () => {
  it('is the chat id in name mode, and per topic in topics mode', () => {
    expect(sessionKey(5, 77, 'name')).toBe('5')
    expect(sessionKey(5, 77, 'topics')).toBe('5:t77')
    expect(sessionKey(5, undefined, 'topics')).toBe('5')
    expect(chatOfKey('5:t77')).toBe('5')
    expect(chatOfKey('-100123')).toBe('-100123')
  })

  it('reads the thread only in private chats', () => {
    expect(threadOf(privateCtx(77))).toBe(77)
    expect(threadOf(privateCtx())).toBeUndefined()
    expect(threadOf({ chat: { id: -1, type: 'supergroup' }, msg: { message_thread_id: 9 } } as any)).toBeUndefined()
  })

  it('follows the per-chat setting', () => {
    expect(getSessionMode(5)).toBe('name')
    expect(keyOf(privateCtx(77))).toBe('5')
    settings.set('5:session_mode', 'topics')
    expect(getSessionMode(5)).toBe('topics')
    expect(keyOf(privateCtx(77))).toBe('5:t77')
    settings.clear()
  })
})

describe('routeIntoThread', () => {
  function withTransformer() {
    let transformer: any
    const ctx = { chat: { id: 5, type: 'private' }, api: { config: { use: (t: any) => { transformer = t } } } } as any
    routeIntoThread(ctx, 77)
    const prev = vi.fn(async (_m: string, p: any) => p)
    return { call: (method: string, payload: any) => transformer(prev, method, payload, undefined), prev }
  }

  it('adds the thread to sends into the same chat', async () => {
    const { call } = withTransformer()
    expect(await call('sendMessage', { chat_id: 5, text: 'x' })).toEqual({ chat_id: 5, text: 'x', message_thread_id: 77 })
    expect(await call('sendRichMessageDraft', { chat_id: 5, draft_id: 1 })).toMatchObject({ message_thread_id: 77 })
  })

  it('leaves other chats, explicit threads and non-send methods alone', async () => {
    const { call } = withTransformer()
    expect(await call('sendMessage', { chat_id: 6, text: 'x' })).toEqual({ chat_id: 6, text: 'x' })
    expect(await call('sendMessage', { chat_id: 5, message_thread_id: 3 })).toEqual({ chat_id: 5, message_thread_id: 3 })
    expect(await call('editMessageText', { chat_id: 5, message_id: 1 })).toEqual({ chat_id: 5, message_id: 1 })
  })
})
