import { describe, it, expect, vi, beforeEach } from 'vitest'

const { STORE } = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  return { STORE: mkdtempSync(join(tmpdir(), 'biz-store-')) }
})
vi.mock('../config.js', () => ({ STORE_DIR: STORE }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { getDb } from '../db.js'
import { onBusinessConnection, onBusinessMessage, businessRouteFor, businessStatus, REPLY_WINDOW_S, _resetBusinessForTests } from './business.js'

const OWNER = 42
const T = 1_800_000_000
const conn = (over: Record<string, unknown> = {}) => ({ id: 'BC1', user: { id: OWNER }, user_chat_id: OWNER, is_enabled: true, rights: { can_reply: true }, ...over })
const incoming = (chat: number, date = T, from = chat) => ({ business_connection_id: 'BC1', chat: { id: chat, type: 'private' }, from: { id: from }, date })

beforeEach(() => {
  getDb().exec('DROP TABLE IF EXISTS business_connections; DROP TABLE IF EXISTS business_chats;')
  _resetBusinessForTests()
})

describe('business routing', () => {
  it('routes a covered chat inside the reply window', () => {
    onBusinessConnection(conn(), T)
    onBusinessMessage(incoming(7))
    expect(businessRouteFor('7', T + 60)).toBe('BC1')
    expect(businessStatus(T + 60)).toEqual({ connected: true, canReply: true, chatsInWindow: 1 })
  })

  it('keeps the observer route for chats it never heard from', () => {
    onBusinessConnection(conn(), T)
    expect(businessRouteFor('8', T)).toBeNull()
  })

  it('closes the window after 23 hours', () => {
    onBusinessConnection(conn(), T)
    onBusinessMessage(incoming(7))
    expect(businessRouteFor('7', T + REPLY_WINDOW_S + 1)).toBeNull()
  })

  it('does not let the owner\'s own messages open the window', () => {
    onBusinessConnection(conn(), T)
    onBusinessMessage(incoming(7, T, OWNER))
    expect(businessRouteFor('7', T)).toBeNull()
  })

  it('needs the right to reply and a live connection', () => {
    onBusinessConnection(conn({ rights: { can_reply: false } }), T)
    onBusinessMessage(incoming(7))
    expect(businessRouteFor('7', T)).toBeNull()

    onBusinessConnection(conn(), T + 1)
    expect(businessRouteFor('7', T + 1)).toBe('BC1')
    onBusinessConnection(conn({ is_enabled: false }), T + 2)
    expect(businessRouteFor('7', T + 2)).toBeNull()
    expect(businessStatus(T + 2).connected).toBe(false)
  })

  it('ignores messages of unknown connections and non-private chats', () => {
    onBusinessConnection(conn(), T)
    onBusinessMessage({ ...incoming(7), business_connection_id: 'OTHER' })
    onBusinessMessage({ ...incoming(-100), chat: { id: -100, type: 'group' } })
    expect(businessRouteFor('7', T)).toBeNull()
    expect(businessRouteFor('-100', T)).toBeNull()
  })

  it('accepts the pre-9.0 can_reply flag', () => {
    onBusinessConnection({ id: 'BC1', user: { id: OWNER }, user_chat_id: OWNER, is_enabled: true, can_reply: true }, T)
    onBusinessMessage(incoming(7))
    expect(businessRouteFor('7', T)).toBe('BC1')
  })
})
