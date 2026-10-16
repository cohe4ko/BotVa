import { describe, it, expect, vi } from 'vitest'

vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { sendErrorHint } = await import('./builtin-tools.js')

describe('sendErrorHint', () => {
  it('blames the recipient access list for BOT_ACCESS_RESTRICTED, not bot-to-bot mode', () => {
    const h = sendErrorHint('Bad Request: BOT_ACCESS_RESTRICTED')
    expect(h).toContain('only accepts selected users')
    expect(h).toContain('not the problem')
  })
  it('names bot-to-bot mode for USER_BOT_TO_BOT_DISABLED', () => {
    expect(sendErrorHint('Bad Request: USER_BOT_TO_BOT_DISABLED')).toContain('Bot-to-Bot Communication Mode')
  })
  it('recognises an unknown username', () => {
    expect(sendErrorHint('Bad Request: chat not found')).toContain('no such bot')
  })
  it('says nothing for an unrelated error', () => {
    expect(sendErrorHint('ETIMEDOUT')).toBe('')
  })
})
