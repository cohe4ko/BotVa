import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  readWorkspaceFile,
  writeWorkspaceFile,
  isWritableFile,
  isGlobalFile,
  isValidWorkspaceFile,
  hasWorkspaceFiles,
  listWorkspaceFiles,
  assembleFromWorkspaceFiles,
  setRolesDirForTesting,
  readBotFeatures,
  processConditionalBlocks,
} from './workspace-files.js'

let botDir: string
let rolesDir: string

beforeAll(() => {
  // Fake roles dir with global files
  rolesDir = mkdtempSync(join(tmpdir(), 'botva-roles-test-'))
  writeFileSync(join(rolesDir, '_soul.md'), '# Global Soul\nBe helpful and direct.')
  writeFileSync(join(rolesDir, '_tools.md'), '# Global Tools\nUse CreateReminder for cron.')
  setRolesDirForTesting(rolesDir)

  // Bot dir with per-bot files
  botDir = mkdtempSync(join(tmpdir(), 'botva-ws-test-'))
  const wsDir = join(botDir, 'workspace-files')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'IDENTITY.md'), '# TestBot\nI am a test bot.')
  writeFileSync(join(wsDir, 'BOT_SOUL.md'), '# Per-bot soul\nExtra warmth.')
  writeFileSync(join(wsDir, 'ROLE.md'), '# Role\nDo testing.')
  writeFileSync(join(wsDir, 'BOT_TOOLS.md'), '# Role-specific tools\nPrefer Bash.')
  writeFileSync(join(wsDir, 'USER.md'), '# User\nPrefers dark mode.')
})

afterAll(() => {
  setRolesDirForTesting(null)
  try { rmSync(botDir, { recursive: true, force: true }) } catch { /* ok */ }
  try { rmSync(rolesDir, { recursive: true, force: true }) } catch { /* ok */ }
})

describe('readWorkspaceFile', () => {
  it('reads existing per-bot file', () => {
    const content = readWorkspaceFile(botDir, 'IDENTITY.md')
    expect(content).toContain('TestBot')
  })

  it('routes SOUL.md to roles/_soul.md (global)', () => {
    const content = readWorkspaceFile(botDir, 'SOUL.md')
    expect(content).toContain('Global Soul')
    expect(content).toContain('Be helpful')
  })

  it('routes TOOLS.md to roles/_tools.md (global)', () => {
    const content = readWorkspaceFile(botDir, 'TOOLS.md')
    expect(content).toContain('Global Tools')
    expect(content).toContain('CreateReminder')
  })

  it('returns null for non-existent per-bot file', () => {
    expect(readWorkspaceFile(botDir, 'MEMORY.md')).toBeNull()
  })

  it('returns null for invalid filename', () => {
    expect(readWorkspaceFile(botDir, 'INVALID.md' as any)).toBeNull()
  })
})

describe('writeWorkspaceFile', () => {
  it('writes to writable file (USER.md)', () => {
    writeWorkspaceFile(botDir, 'USER.md', '# Updated User')
    const content = readWorkspaceFile(botDir, 'USER.md')
    expect(content).toBe('# Updated User')
  })

  it('writes to writable file (MEMORY.md)', () => {
    writeWorkspaceFile(botDir, 'MEMORY.md', '# Memory')
    const content = readWorkspaceFile(botDir, 'MEMORY.md')
    expect(content).toBe('# Memory')
  })

  it('throws for read-only per-bot file (IDENTITY.md)', () => {
    expect(() => writeWorkspaceFile(botDir, 'IDENTITY.md', 'hack')).toThrow('read-only')
  })

  it('throws for global file (SOUL.md) with helpful message', () => {
    expect(() => writeWorkspaceFile(botDir, 'SOUL.md', 'hack')).toThrow(/global.*roles\/_soul\.md/)
  })

  it('throws for global file (TOOLS.md) with helpful message', () => {
    expect(() => writeWorkspaceFile(botDir, 'TOOLS.md', 'hack')).toThrow(/global.*roles\/_tools\.md/)
  })
})

describe('validation helpers', () => {
  it('isWritableFile', () => {
    expect(isWritableFile('USER.md')).toBe(true)
    expect(isWritableFile('MEMORY.md')).toBe(true)
    expect(isWritableFile('SOUL.md')).toBe(false)
    expect(isWritableFile('IDENTITY.md')).toBe(false)
  })

  it('isGlobalFile', () => {
    expect(isGlobalFile('SOUL.md')).toBe(true)
    expect(isGlobalFile('TOOLS.md')).toBe(true)
    expect(isGlobalFile('BOT_SOUL.md')).toBe(false)
    expect(isGlobalFile('BOT_TOOLS.md')).toBe(false)
    expect(isGlobalFile('IDENTITY.md')).toBe(false)
  })

  it('isValidWorkspaceFile', () => {
    expect(isValidWorkspaceFile('SOUL.md')).toBe(true)
    expect(isValidWorkspaceFile('BOT_SOUL.md')).toBe(true)
    expect(isValidWorkspaceFile('BOT_TOOLS.md')).toBe(true)
    expect(isValidWorkspaceFile('RANDOM.md')).toBe(false)
  })
})

describe('hasWorkspaceFiles', () => {
  it('returns true when IDENTITY.md exists on disk', () => {
    expect(hasWorkspaceFiles(botDir)).toBe(true)
  })

  it('returns false for empty dir', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'botva-empty-'))
    expect(hasWorkspaceFiles(emptyDir)).toBe(false)
    rmSync(emptyDir, { recursive: true, force: true })
  })
})

describe('listWorkspaceFiles', () => {
  it('returns info for all 8 workspace files', () => {
    const list = listWorkspaceFiles(botDir)
    expect(list.length).toBe(8)
    const names = list.map(f => f.name)
    expect(names).toEqual([
      'IDENTITY.md',
      'SOUL.md',
      'BOT_SOUL.md',
      'ROLE.md',
      'TOOLS.md',
      'BOT_TOOLS.md',
      'USER.md',
      'MEMORY.md',
    ])
  })

  it('marks SOUL.md and TOOLS.md as global', () => {
    const list = listWorkspaceFiles(botDir)
    const soul = list.find(f => f.name === 'SOUL.md')!
    const tools = list.find(f => f.name === 'TOOLS.md')!
    expect(soul.global).toBe(true)
    expect(soul.exists).toBe(true) // exists in fake rolesDir
    expect(soul.size).toBeGreaterThan(0)
    expect(tools.global).toBe(true)
    expect(tools.exists).toBe(true)
  })

  it('marks per-bot files as non-global', () => {
    const list = listWorkspaceFiles(botDir)
    expect(list.find(f => f.name === 'BOT_SOUL.md')!.global).toBe(false)
    expect(list.find(f => f.name === 'BOT_TOOLS.md')!.global).toBe(false)
    expect(list.find(f => f.name === 'IDENTITY.md')!.global).toBe(false)
  })
})

describe('assembleFromWorkspaceFiles', () => {
  it('combines global and per-bot files in order', () => {
    const result = assembleFromWorkspaceFiles(botDir)
    // All sections present
    expect(result).toContain('TestBot')           // IDENTITY
    expect(result).toContain('Global Soul')        // SOUL (from rolesDir)
    expect(result).toContain('Per-bot soul')       // BOT_SOUL
    expect(result).toContain('Do testing')         // ROLE
    expect(result).toContain('Global Tools')       // TOOLS (from rolesDir)
    expect(result).toContain('Prefer Bash')        // BOT_TOOLS

    // Order check: IDENTITY → SOUL → BOT_SOUL → ROLE → TOOLS → BOT_TOOLS
    const idx = (s: string) => result.indexOf(s)
    expect(idx('TestBot')).toBeLessThan(idx('Global Soul'))
    expect(idx('Global Soul')).toBeLessThan(idx('Per-bot soul'))
    expect(idx('Per-bot soul')).toBeLessThan(idx('Do testing'))
    expect(idx('Do testing')).toBeLessThan(idx('Global Tools'))
    expect(idx('Global Tools')).toBeLessThan(idx('Prefer Bash'))
  })

  it('reflects live changes to roles/_tools.md without rebuilding bot files', () => {
    writeFileSync(join(rolesDir, '_tools.md'), '# Updated Tools\nNew rule about cron.')
    const result = assembleFromWorkspaceFiles(botDir)
    expect(result).toContain('Updated Tools')
    expect(result).toContain('New rule about cron')
    expect(result).not.toContain('Global Tools')
  })
})

describe('REPLACES_GLOBAL marker', () => {
  let markerBotDir: string
  beforeAll(() => {
    markerBotDir = mkdtempSync(join(tmpdir(), 'botva-marker-test-'))
    const wsDir = join(markerBotDir, 'workspace-files')
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(join(wsDir, 'IDENTITY.md'), '# MarkerBot')
    writeFileSync(
      join(wsDir, 'BOT_SOUL.md'),
      '<!-- REPLACES_GLOBAL -->\n# Authorial Soul\nUnique persona, no global mixed in.'
    )
    writeFileSync(join(wsDir, 'BOT_TOOLS.md'), '# Bot tools\nRole-specific routing.')
  })
  afterAll(() => {
    try { rmSync(markerBotDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('skips global SOUL.md when BOT_SOUL.md has marker', () => {
    // global _soul.md was rewritten in earlier test — re-set known content
    writeFileSync(join(rolesDir, '_soul.md'), '# Global Soul\nBe helpful and direct.')
    const result = assembleFromWorkspaceFiles(markerBotDir)
    expect(result).not.toContain('Global Soul')
    expect(result).toContain('Authorial Soul')
  })

  it('strips the marker line from output', () => {
    const result = assembleFromWorkspaceFiles(markerBotDir)
    expect(result).not.toContain('<!-- REPLACES_GLOBAL -->')
    expect(result).toContain('Unique persona')
  })

  it('does NOT skip global TOOLS.md when BOT_TOOLS.md has no marker', () => {
    writeFileSync(join(rolesDir, '_tools.md'), '# Global Tools\nUse CreateReminder.')
    const result = assembleFromWorkspaceFiles(markerBotDir)
    expect(result).toContain('Global Tools')      // global still injected
    expect(result).toContain('Role-specific routing') // overlay still appended
  })
})

describe('readBotFeatures', () => {
  let featBotDir: string
  beforeAll(() => {
    featBotDir = mkdtempSync(join(tmpdir(), 'botva-features-test-'))
    writeFileSync(join(featBotDir, '.env'), [
      '# Test env',
      'TELEGRAM_BOT_TOKEN=secret',
      'GROUP_CHAT_ENABLED=1',
      'DEV_MODE_ENABLED=true',
      'GIT_ACCESS_ENABLED=0',
      'UNRELATED_KEY=foo',
    ].join('\n'))
  })
  afterAll(() => {
    try { rmSync(featBotDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('reads enabled feature flags from .env', () => {
    const features = readBotFeatures(featBotDir)
    expect(features.has('GROUP_CHAT_ENABLED')).toBe(true)
    expect(features.has('DEV_MODE_ENABLED')).toBe(true)
    expect(features.has('GIT_ACCESS_ENABLED')).toBe(false)
  })

  it('ignores unknown env keys', () => {
    const features = readBotFeatures(featBotDir)
    expect(features.has('UNRELATED_KEY')).toBe(false)
    expect(features.has('TELEGRAM_BOT_TOKEN')).toBe(false)
  })

  it('returns empty set when .env missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'botva-no-env-'))
    expect(readBotFeatures(empty).size).toBe(0)
    rmSync(empty, { recursive: true, force: true })
  })
})

describe('processConditionalBlocks', () => {
  it('keeps content inside IF when feature enabled', () => {
    const input = 'before\n<!-- IF FOO -->\ninside\n<!-- END -->\nafter'
    const result = processConditionalBlocks(input, new Set(['FOO']))
    expect(result).toContain('inside')
    expect(result).toContain('before')
    expect(result).toContain('after')
    expect(result).not.toContain('<!-- IF FOO -->')
    expect(result).not.toContain('<!-- END -->')
  })

  it('drops content inside IF when feature disabled', () => {
    const input = 'before\n<!-- IF FOO -->\ninside\n<!-- END -->\nafter'
    const result = processConditionalBlocks(input, new Set())
    expect(result).not.toContain('inside')
    expect(result).toContain('before')
    expect(result).toContain('after')
    expect(result).not.toContain('<!-- IF')
    expect(result).not.toContain('<!-- END -->')
  })

  it('handles multiple IF blocks', () => {
    const input = '<!-- IF A -->\nblock-a\n<!-- END -->\n<!-- IF B -->\nblock-b\n<!-- END -->'
    const result = processConditionalBlocks(input, new Set(['A']))
    expect(result).toContain('block-a')
    expect(result).not.toContain('block-b')
  })

  it('handles nested IF blocks', () => {
    const input = '<!-- IF OUTER -->\nouter-pre\n<!-- IF INNER -->\ninner\n<!-- END -->\nouter-post\n<!-- END -->'
    const r1 = processConditionalBlocks(input, new Set(['OUTER', 'INNER']))
    expect(r1).toContain('outer-pre')
    expect(r1).toContain('inner')
    expect(r1).toContain('outer-post')

    const r2 = processConditionalBlocks(input, new Set(['OUTER']))
    expect(r2).toContain('outer-pre')
    expect(r2).not.toContain('inner')
    expect(r2).toContain('outer-post')

    const r3 = processConditionalBlocks(input, new Set())
    expect(r3).not.toContain('outer-pre')
    expect(r3).not.toContain('inner')
    expect(r3).not.toContain('outer-post')
  })

  it('leaves content untouched when no markers', () => {
    const input = 'just plain content\nwith multiple lines'
    expect(processConditionalBlocks(input, new Set(['ANY']))).toBe(input)
  })
})

describe('conditional sections in assembled CLAUDE.md', () => {
  let condBotDir: string
  beforeAll(() => {
    // Reset rolesDir with known SOUL containing IF block
    writeFileSync(
      join(rolesDir, '_soul.md'),
      '# Global Soul\nAlways present.\n<!-- IF DEV_MODE_ENABLED -->\n## Dev mode section\nDev-only guidance.\n<!-- END -->\nEnd of soul.'
    )
    writeFileSync(join(rolesDir, '_tools.md'), '# Tools')

    condBotDir = mkdtempSync(join(tmpdir(), 'botva-cond-test-'))
    const wsDir = join(condBotDir, 'workspace-files')
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(join(wsDir, 'IDENTITY.md'), '# CondBot')
  })
  afterAll(() => {
    try { rmSync(condBotDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('includes IF block when feature flag set in .env', () => {
    writeFileSync(join(condBotDir, '.env'), 'DEV_MODE_ENABLED=1\n')
    const result = assembleFromWorkspaceFiles(condBotDir)
    expect(result).toContain('Always present')
    expect(result).toContain('Dev mode section')
    expect(result).toContain('Dev-only guidance')
    expect(result).toContain('End of soul')
    expect(result).not.toContain('<!-- IF')
    expect(result).not.toContain('<!-- END')
  })

  it('excludes IF block when feature flag not set', () => {
    writeFileSync(join(condBotDir, '.env'), 'DEV_MODE_ENABLED=0\n')
    const result = assembleFromWorkspaceFiles(condBotDir)
    expect(result).toContain('Always present')
    expect(result).not.toContain('Dev mode section')
    expect(result).not.toContain('Dev-only guidance')
    expect(result).toContain('End of soul')
  })

  it('excludes IF block when .env missing', () => {
    const noEnvBot = mkdtempSync(join(tmpdir(), 'botva-noenv-'))
    const ws = join(noEnvBot, 'workspace-files')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'IDENTITY.md'), '# X')
    const result = assembleFromWorkspaceFiles(noEnvBot)
    expect(result).not.toContain('Dev mode section')
    rmSync(noEnvBot, { recursive: true, force: true })
  })
})
