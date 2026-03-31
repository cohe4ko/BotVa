import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { loadCatalog, getProfile, clearCatalogCache, buildAgentDefinitions } from './agent-catalog.js'

const TEST_DIR = join(tmpdir(), 'botva-test-agents-' + Date.now())

beforeEach(() => {
  clearCatalogCache()
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

const VALID_AGENT = `---
name: Code Reviewer
description: Expert code reviewer for best practices
color: purple
emoji: 🔍
vibe: constructive and thorough
tools: WebFetch, Read, Edit
---

# Code Reviewer Agent

You are an expert code reviewer.

## Rules
- Be constructive
- Focus on correctness
`

const MINIMAL_AGENT = `---
name: Simple Agent
description: A simple test agent
emoji: 🤖
---

Just a simple agent.
`

const INVALID_AGENT = `No frontmatter here, just text.`

describe('agent-catalog', () => {
  describe('loadCatalog', () => {
    it('parses valid agent with all fields', () => {
      writeFileSync(join(TEST_DIR, 'engineering-code-reviewer.md'), VALID_AGENT)
      const catalog = loadCatalog(TEST_DIR)

      expect(catalog).toHaveLength(1)
      expect(catalog[0].slug).toBe('engineering-code-reviewer')
      expect(catalog[0].name).toBe('Code Reviewer')
      expect(catalog[0].description).toBe('Expert code reviewer for best practices')
      expect(catalog[0].emoji).toBe('🔍')
      expect(catalog[0].tools).toEqual(['WebFetch', 'Read', 'Edit'])
      expect(catalog[0].prompt).toContain('# Code Reviewer Agent')
      expect(catalog[0].prompt).toContain('Be constructive')
    })

    it('parses minimal agent without tools', () => {
      writeFileSync(join(TEST_DIR, 'simple-agent.md'), MINIMAL_AGENT)
      const catalog = loadCatalog(TEST_DIR)

      expect(catalog).toHaveLength(1)
      expect(catalog[0].slug).toBe('simple-agent')
      expect(catalog[0].name).toBe('Simple Agent')
      expect(catalog[0].emoji).toBe('🤖')
      expect(catalog[0].tools).toBeUndefined()
    })

    it('skips files without valid frontmatter', () => {
      writeFileSync(join(TEST_DIR, 'invalid.md'), INVALID_AGENT)
      writeFileSync(join(TEST_DIR, 'valid.md'), MINIMAL_AGENT)
      const catalog = loadCatalog(TEST_DIR)

      expect(catalog).toHaveLength(1)
      expect(catalog[0].slug).toBe('valid')
    })

    it('skips non-md files', () => {
      writeFileSync(join(TEST_DIR, 'readme.txt'), 'not an agent')
      writeFileSync(join(TEST_DIR, 'valid.md'), MINIMAL_AGENT)
      const catalog = loadCatalog(TEST_DIR)

      expect(catalog).toHaveLength(1)
    })

    it('returns empty array for missing directory', () => {
      const catalog = loadCatalog('/nonexistent/path/agents')
      expect(catalog).toEqual([])
    })

    it('caches results within TTL', () => {
      writeFileSync(join(TEST_DIR, 'a.md'), MINIMAL_AGENT)
      const first = loadCatalog(TEST_DIR)
      // Add another file — should still return cached
      writeFileSync(join(TEST_DIR, 'b.md'), MINIMAL_AGENT)
      const second = loadCatalog(TEST_DIR)

      expect(first).toBe(second) // same reference = cached
    })

    it('reloads after cache clear', () => {
      writeFileSync(join(TEST_DIR, 'a.md'), MINIMAL_AGENT)
      const first = loadCatalog(TEST_DIR)
      expect(first).toHaveLength(1)

      writeFileSync(join(TEST_DIR, 'b.md'), MINIMAL_AGENT)
      clearCatalogCache()
      const second = loadCatalog(TEST_DIR)
      expect(second).toHaveLength(2)
    })
  })

  describe('getProfile', () => {
    it('returns profile by slug', () => {
      writeFileSync(join(TEST_DIR, 'my-agent.md'), MINIMAL_AGENT)
      const profile = getProfile('my-agent', TEST_DIR)
      expect(profile).toBeDefined()
      expect(profile!.name).toBe('Simple Agent')
    })

    it('returns undefined for missing slug', () => {
      writeFileSync(join(TEST_DIR, 'my-agent.md'), MINIMAL_AGENT)
      expect(getProfile('nonexistent', TEST_DIR)).toBeUndefined()
    })
  })

  describe('buildAgentDefinitions', () => {
    it('builds definitions with Ukrainian language', () => {
      writeFileSync(join(TEST_DIR, 'test-agent.md'), VALID_AGENT)
      const catalog = loadCatalog(TEST_DIR)
      const defs = buildAgentDefinitions(catalog, 'uk')

      expect(defs['test-agent']).toBeDefined()
      const def = defs['test-agent']
      expect(def.description).toContain('🔍 Code Reviewer')
      expect(def.prompt).toContain('українською')
      expect(def.prompt).toContain('# Code Reviewer Agent')
      expect(def.tools).toEqual(['WebFetch', 'Read', 'Edit'])
      expect(def.maxTurns).toBe(15)
    })

    it('builds definitions with English language', () => {
      writeFileSync(join(TEST_DIR, 'test-agent.md'), MINIMAL_AGENT)
      const catalog = loadCatalog(TEST_DIR)
      const defs = buildAgentDefinitions(catalog, 'en')

      const def = defs['test-agent']
      expect(def.prompt).toContain('English')
      expect(def.tools).toBeUndefined()
    })

    it('returns empty object for empty catalog', () => {
      const defs = buildAgentDefinitions([], 'uk')
      expect(defs).toEqual({})
    })
  })
})
