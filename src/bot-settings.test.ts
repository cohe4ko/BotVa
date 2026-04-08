import { describe, it, expect, vi } from 'vitest'

// --- Mocks ---

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./db.js', () => ({
  getChatSetting: () => undefined,
  setChatSetting: vi.fn(),
  deleteChatSetting: vi.fn(),
  getSession: () => undefined,
  setSession: vi.fn(),
  clearSession: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock('./bot-i18n.js', () => ({
  chatT: () => (key: string) => key,
  getChatLang: () => 'uk',
  setChatLang: vi.fn(),
}))

vi.mock('./model.js', () => ({
  getModel: () => 'opus',
  setModel: vi.fn(),
  MODELS: [{ id: 'opus', label: 'Opus' }],
  getModelLabel: (id: string) => id,
}))

vi.mock('./config.js', () => ({
  BOT_DIR: '/tmp/bot',
}))

// Fixture: return projects with a mix of short and pathologically long keys.
// The long ones are the regression case — raw key alone exceeds 55 bytes,
// which would push `ses:proj:<key>:0` past Telegram's 64-byte limit.
const mockProjects = [
  { key: '-Users-ivan-short', label: 'short', sessionCount: 1, lastUpdated: Math.floor(Date.now() / 1000) },
  {
    key: '-Users-ivan-BotVa--claude-worktrees-distracted-driscoll',
    label: 'BotVa/worktrees/distracted-driscoll',
    sessionCount: 3,
    lastUpdated: Math.floor(Date.now() / 1000) - 3600,
  },
  {
    // Extreme case: 100-byte raw key. Any scheme that inlines the key will fail.
    key: '-Users-ivan-' + 'x'.repeat(88),
    label: 'very-long-project',
    sessionCount: 1,
    lastUpdated: Math.floor(Date.now() / 1000) - 7200,
  },
]

vi.mock('./disk-sessions.js', () => ({
  listClaudeProjects: () => mockProjects,
  listDiskSessionsByKey: (key: string) => {
    // Return enough sessions to force pagination for the long-key project
    if (key.includes('distracted-driscoll')) {
      return Array.from({ length: 12 }, (_, i) => ({
        sessionId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        title: `session ${i}`,
        preview: `preview ${i}`,
        updatedAt: Math.floor(Date.now() / 1000) - i * 60,
      }))
    }
    return []
  },
  getSessionDetail: () => null,
}))

import { buildProjectsMessage, buildSessionMessage } from './bot-settings.js'

function assertAllCallbacksUnder64Bytes(replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }) {
  for (const row of replyMarkup.inline_keyboard) {
    for (const btn of row) {
      const size = Buffer.byteLength(btn.callback_data, 'utf8')
      if (size > 64) {
        throw new Error(`callback_data "${btn.callback_data}" is ${size} bytes (>64)`)
      }
      expect(size).toBeLessThanOrEqual(64)
    }
  }
}

describe('buildProjectsMessage', () => {
  it('every callback_data stays within Telegram 64-byte limit', () => {
    const { reply_markup } = buildProjectsMessage('12345', 0)
    assertAllCallbacksUnder64Bytes(reply_markup)
  })

  it('project buttons encode page+index, not raw keys', () => {
    const { reply_markup } = buildProjectsMessage('12345', 0)
    const projectButtons = reply_markup.inline_keyboard
      .flat()
      .filter(b => b.callback_data.startsWith('ses:pidx:'))
    expect(projectButtons.length).toBeGreaterThan(0)
    for (const btn of projectButtons) {
      // ses:pidx:<projectsPage>:<idxOnPage>:<sessionsPage>
      expect(btn.callback_data).toMatch(/^ses:pidx:\d+:\d+:\d+$/)
      // Raw keys must not leak into callbacks
      expect(btn.callback_data).not.toContain('-Users-ivan-')
    }
  })
})

describe('buildSessionMessage', () => {
  it('every callback_data stays within Telegram 64-byte limit even with long project key', () => {
    const longKey = '-Users-ivan-BotVa--claude-worktrees-distracted-driscoll'
    const { reply_markup } = buildSessionMessage('12345', longKey, 0, 0, 1)
    assertAllCallbacksUnder64Bytes(reply_markup)
  })

  it('nav buttons use pidx:<projectsPage>:<idxOnPage>:<sessionsPage>', () => {
    const longKey = '-Users-ivan-BotVa--claude-worktrees-distracted-driscoll'
    const { reply_markup } = buildSessionMessage('12345', longKey, 0, 2, 3)
    const navButtons = reply_markup.inline_keyboard
      .flat()
      .filter(b => b.callback_data.startsWith('ses:pidx:') || b.callback_data.startsWith('ses:projects:'))
    expect(navButtons.length).toBeGreaterThan(0)
    for (const btn of navButtons) {
      if (btn.callback_data.startsWith('ses:pidx:')) {
        expect(btn.callback_data).toMatch(/^ses:pidx:2:3:\d+$/)
      } else {
        expect(btn.callback_data).toBe('ses:projects:2')
      }
      expect(btn.callback_data).not.toContain('-Users-ivan-')
    }
  })
})
