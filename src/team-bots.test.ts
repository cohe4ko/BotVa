import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { botIdFromToken, teamBotIds, _resetTeamBotsCache } from './team-bots.js'

describe('botIdFromToken', () => {
  it('reads the id prefix of a bot token', () => {
    expect(botIdFromToken('1234567:fake_secret-x')).toBe(1234567)
    expect(botIdFromToken(' 1234567:fake ')).toBe(1234567)
    expect(botIdFromToken('nope')).toBeNull()
    expect(botIdFromToken(undefined)).toBeNull()
  })
})

describe('teamBotIds', () => {
  beforeEach(() => _resetTeamBotsCache())

  it('collects ids from every bots/<name>/.env', () => {
    const root = mkdtempSync(join(tmpdir(), 'team-bots-'))
    for (const [name, line] of [['a', 'TELEGRAM_BOT_TOKEN=111111:fake'], ['b', 'X=1\nTELEGRAM_BOT_TOKEN="222222:fake"'], ['c', 'NO_TOKEN=1']]) {
      mkdirSync(join(root, 'bots', name), { recursive: true })
      writeFileSync(join(root, 'bots', name, '.env'), line + '\n')
    }
    expect([...teamBotIds(root)].sort()).toEqual([111111, 222222])
  })

  it('is empty without a bots directory', () => {
    expect(teamBotIds(mkdtempSync(join(tmpdir(), 'team-bots-empty-'))).size).toBe(0)
  })
})
