import { describe, it, expect, vi } from 'vitest'

// Mock env.js to provide controlled env values
vi.mock('./env.js', () => ({
  readEnvFile: () => ({
    NIGHT_OWL_HOUR: '5',
    TELEGRAPH_ENABLED: 'false',
    AGENT_WATCHDOG_WARN_SECONDS: '120',
  }),
  BOT_NAME: 'TestBot',
  BOT_DIR: '/tmp/test-bot',
}))

import {
  NIGHT_OWL_HOUR,
  TELEGRAPH_ENABLED,
  AGENT_WATCHDOG_WARN_SECONDS,
  MAX_MESSAGE_LENGTH,
  BOT_NAME,
} from './config.js'

describe('config', () => {
  it('parses NIGHT_OWL_HOUR from env', () => {
    expect(NIGHT_OWL_HOUR).toBe(5)
  })

  it('parses TELEGRAPH_ENABLED as boolean', () => {
    expect(TELEGRAPH_ENABLED).toBe(false)
  })

  it('parses AGENT_WATCHDOG_WARN_SECONDS as int', () => {
    expect(AGENT_WATCHDOG_WARN_SECONDS).toBe(120)
  })

  it('has hardcoded MAX_MESSAGE_LENGTH', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(4096)
  })

  it('exports BOT_NAME from env', () => {
    expect(BOT_NAME).toBe('TestBot')
  })
})
