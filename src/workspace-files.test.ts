import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  readWorkspaceFile,
  writeWorkspaceFile,
  isWritableFile,
  isValidWorkspaceFile,
  hasWorkspaceFiles,
  listWorkspaceFiles,
  assembleFromWorkspaceFiles,
  getWorkspaceDir,
} from './workspace-files.js'

let botDir: string

beforeAll(() => {
  botDir = mkdtempSync(join(tmpdir(), 'botva-ws-test-'))
  const wsDir = join(botDir, 'workspace-files')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'IDENTITY.md'), '# TestBot\nI am a test bot.')
  writeFileSync(join(wsDir, 'SOUL.md'), '# Soul\nBe helpful.')
  writeFileSync(join(wsDir, 'USER.md'), '# User\nPrefers dark mode.')
})

afterAll(() => {
  try { rmSync(botDir, { recursive: true, force: true }) } catch { /* ok */ }
})

describe('readWorkspaceFile', () => {
  it('reads existing file', () => {
    const content = readWorkspaceFile(botDir, 'IDENTITY.md')
    expect(content).toContain('TestBot')
  })

  it('returns null for non-existent file', () => {
    expect(readWorkspaceFile(botDir, 'ROLE.md')).toBeNull()
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

  it('throws for read-only file', () => {
    expect(() => writeWorkspaceFile(botDir, 'SOUL.md', 'hack')).toThrow('read-only')
  })
})

describe('validation helpers', () => {
  it('isWritableFile', () => {
    expect(isWritableFile('USER.md')).toBe(true)
    expect(isWritableFile('MEMORY.md')).toBe(true)
    expect(isWritableFile('SOUL.md')).toBe(false)
    expect(isWritableFile('IDENTITY.md')).toBe(false)
  })

  it('isValidWorkspaceFile', () => {
    expect(isValidWorkspaceFile('SOUL.md')).toBe(true)
    expect(isValidWorkspaceFile('RANDOM.md')).toBe(false)
  })
})

describe('hasWorkspaceFiles', () => {
  it('returns true when SOUL.md and IDENTITY.md exist', () => {
    expect(hasWorkspaceFiles(botDir)).toBe(true)
  })

  it('returns false for empty dir', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'botva-empty-'))
    expect(hasWorkspaceFiles(emptyDir)).toBe(false)
    rmSync(emptyDir, { recursive: true, force: true })
  })
})

describe('listWorkspaceFiles', () => {
  it('returns info for all workspace files', () => {
    const list = listWorkspaceFiles(botDir)
    expect(list.length).toBe(6) // IDENTITY, SOUL, ROLE, TOOLS, USER, MEMORY
    const identity = list.find(f => f.name === 'IDENTITY.md')
    expect(identity?.exists).toBe(true)
    expect(identity?.writable).toBe(false)
    expect(identity?.size).toBeGreaterThan(0)
  })
})

describe('assembleFromWorkspaceFiles', () => {
  it('combines existing files in order', () => {
    const result = assembleFromWorkspaceFiles(botDir)
    expect(result).toContain('TestBot')
    expect(result).toContain('Be helpful')
    // IDENTITY comes before SOUL in assembly order
    const identityIdx = result.indexOf('TestBot')
    const soulIdx = result.indexOf('Be helpful')
    expect(identityIdx).toBeLessThan(soulIdx)
  })
})
