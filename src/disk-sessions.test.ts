import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { getClaudeProjectDir } from './disk-sessions.js'

describe('getClaudeProjectDir', () => {
  it('converts path to project key format', () => {
    const dir = getClaudeProjectDir('/tmp/project/bots/cap')
    expect(dir).toContain('-tmp-project-bots-cap')
  })
})

// projectLabel is private, but we can test it indirectly via listClaudeProjects
// For now, test the exported utility functions

describe('disk-sessions module', () => {
  it('exports expected functions', async () => {
    const mod = await import('./disk-sessions.js')
    expect(typeof mod.getClaudeProjectDir).toBe('function')
    expect(typeof mod.listDiskSessions).toBe('function')
    expect(typeof mod.listDiskSessionsByKey).toBe('function')
    expect(typeof mod.listClaudeProjects).toBe('function')
    expect(typeof mod.getSessionDetail).toBe('function')
  })
})
