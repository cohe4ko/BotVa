import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    GOOGLE_API_KEY: 'test-key',
    GROQ_API_KEY: 'test-groq',
    SMTP_HOST: 'smtp.test',
    SMTP_USER: 'user',
    SMTP_PASS: 'pass',
    PUBLISH_BASE_URL: 'https://example.com',
  })),
}))

vi.mock('./config.js', () => ({
  TELEGRAPH_ENABLED: true,
  PROJECT_ROOT: '/tmp/botva-test',
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Mock fs so readConfig returns empty (all defaults enabled)
vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs')>()
  return {
    ...orig,
    existsSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('builtin-tools.json')) return false
      return orig.existsSync(path)
    }),
    readFileSync: orig.readFileSync,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

import { getBuiltinToolDefs, isToolEnabled, type BuiltinToolDef } from './builtin-tools.js'

describe('getBuiltinToolDefs', () => {
  it('returns array of tool definitions', () => {
    const defs = getBuiltinToolDefs()
    expect(Array.isArray(defs)).toBe(true)
    expect(defs.length).toBeGreaterThan(30)
  })

  it('every tool has required fields', () => {
    const defs = getBuiltinToolDefs()
    for (const d of defs) {
      expect(d.name).toBeTruthy()
      expect(d.icon).toBeTruthy()
      expect(d.category).toBeTruthy()
      expect(d.description).toBeTruthy()
      expect(typeof d.available).toBe('boolean')
      expect(typeof d.enabled).toBe('boolean')
    }
  })

  it('no duplicate tool names', () => {
    const defs = getBuiltinToolDefs()
    const names = defs.map(d => d.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('system tools are marked correctly', () => {
    const defs = getBuiltinToolDefs()
    const systemTools = defs.filter(d => d.system)
    expect(systemTools.length).toBeGreaterThanOrEqual(4) // Bash, FileSystem, WebSearch, WebFetch
    for (const t of systemTools) {
      expect(t.available).toBe(true)
    }
  })

  it('all tools enabled by default (no config file)', () => {
    const defs = getBuiltinToolDefs()
    for (const d of defs) {
      expect(d.enabled).toBe(true)
    }
  })
})

describe('isToolEnabled', () => {
  it('returns true for unknown tool (default enabled)', () => {
    expect(isToolEnabled('SomeNewTool')).toBe(true)
  })
})
