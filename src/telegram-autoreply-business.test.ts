import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GrammyError, HttpError } from 'grammy'

const route = vi.hoisted(() => ({ value: null as string | null }))
const outbox = vi.hoisted(() => [] as any[])
const policy = vi.hoisted(() => ({ allowed: true, limit: null as string | null }))

vi.mock('./env.js', () => ({ BOT_NAME: 'cap', BOT_DIR: '/x', readEnvFile: () => ({}) }))
vi.mock('./config.js', () => ({ ALLOWED_CHAT_ID: '', STORE_DIR: '/x', PROJECT_ROOT: '/x' }))
vi.mock('./bot.js', () => ({ sendMessage: vi.fn() }))
vi.mock('./agent.js', () => ({ runAgent: vi.fn() }))
vi.mock('./model.js', () => ({ getBackgroundModel: () => 'm' }))
vi.mock('./db.js', () => ({ getSession: vi.fn(), setSession: vi.fn() }))
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./telegram/bridge.js', () => ({ openObserver: vi.fn() }))
vi.mock('./telegram/business.js', () => ({ businessRouteFor: () => route.value }))
vi.mock('./telegram/send-policy.js', () => ({ isSendAllowed: () => policy.allowed, checkSendLimits: () => policy.limit }))
vi.mock('./telegram/db.js', async (orig) => ({ ...(await orig() as object), recordOutbox: (e: any) => { outbox.push(e); return 1 } }))

import { initAutoReply, stopAutoReply, sendAnswer } from './telegram-autoreply.js'

const candidate = (kind = 'user') => ({ chat: { chat_id: '777', kind } as any, trigger: {} as any, waitedS: 60 })

function setup(send: (...a: any[]) => Promise<any>) {
  const api = { sendMessage: vi.fn(send), raw: { readBusinessMessage: vi.fn(async () => true) } } as any
  const obs = { call: vi.fn(async () => '{}') } as any
  initAutoReply(api)
  stopAutoReply()
  return { api, obs }
}

beforeEach(() => { route.value = null; outbox.length = 0; policy.allowed = true; policy.limit = null })

describe('sendAnswer routing', () => {
  it('replies through Telegram Business when the chat is covered', async () => {
    route.value = 'BC1'
    const { api, obs } = setup(async () => ({ message_id: 5 }))
    await sendAnswer(obs, candidate(), 'hi')
    expect(api.sendMessage).toHaveBeenCalledWith(777, 'hi', { business_connection_id: 'BC1' })
    expect(obs.call).not.toHaveBeenCalled()
    expect(outbox[0]).toMatchObject({ status: 'sent', requested_by: 'cap (business)', msg_id: 5 })
    expect(api.raw.readBusinessMessage).toHaveBeenCalledWith(expect.objectContaining({ business_connection_id: 'BC1', chat_id: 777 }))
  })

  it('respects the same allowlist and limits as the observer', async () => {
    route.value = 'BC1'
    const { api, obs } = setup(async () => ({ message_id: 5 }))
    policy.allowed = false
    await expect(sendAnswer(obs, candidate(), 'hi')).rejects.toThrow(/not allowed/)
    policy.allowed = true
    policy.limit = 'Ліміт вихідних вичерпано: 10 на годину.'
    await expect(sendAnswer(obs, candidate(), 'hi')).rejects.toThrow(/Ліміт/)
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(obs.call).not.toHaveBeenCalled()
  })

  it('uses the observer when Business does not cover the chat, or for groups', async () => {
    const { api, obs } = setup(async () => ({ message_id: 5 }))
    await sendAnswer(obs, candidate(), 'hi')
    route.value = 'BC1'
    await sendAnswer(obs, candidate('group'), 'hi')
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(obs.call).toHaveBeenCalledTimes(2)
  })

  it('falls back to the observer when Telegram refuses the business send', async () => {
    route.value = 'BC1'
    const { obs } = setup(async () => { throw new GrammyError('refused', { ok: false, error_code: 400, description: 'Bad Request: BUSINESS_PEER_INVALID' }, 'sendMessage', {}) })
    await sendAnswer(obs, candidate(), 'hi')
    expect(obs.call).toHaveBeenCalledWith('tg_send_message', { chat: '777', text: 'hi' })
  })

  it('does not send a second copy after a network failure', async () => {
    route.value = 'BC1'
    const { obs } = setup(async () => { throw new HttpError('network', new Error('timeout')) })
    await expect(sendAnswer(obs, candidate(), 'hi')).rejects.toThrow()
    expect(obs.call).not.toHaveBeenCalled()
  })
})
