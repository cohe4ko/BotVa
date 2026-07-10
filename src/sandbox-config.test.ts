import { describe, it, expect } from 'vitest'
import { buildSandboxSettings } from './sandbox-config.js'

describe('buildSandboxSettings', () => {
  it('always enables the sandbox with graceful degradation', () => {
    const s = buildSandboxSettings({})
    expect(s.enabled).toBe(true)
    expect(s.failIfUnavailable).toBe(false)
    // Nothing to mask → no credentials / network keys added.
    expect(s.credentials).toBeUndefined()
    expect(s.network).toBeUndefined()
  })

  it('masks only sensitive vars present in env', () => {
    const s = buildSandboxSettings({ GROQ_API_KEY: 'x', IRRELEVANT: 'y' } as NodeJS.ProcessEnv)
    expect(s.credentials?.envVars).toEqual([
      { name: 'GROQ_API_KEY', mode: 'mask', injectHosts: ['api.groq.com'] },
    ])
    expect(s.network?.allowedDomains).toEqual(['api.groq.com'])
  })

  it('builds the network allowlist from the union of masked hosts, deduped', () => {
    const s = buildSandboxSettings({
      GROQ_API_KEY: 'x',
      GROQ_API_KEYS: 'y',
      OPENAI_API_KEY: 'z',
    } as NodeJS.ProcessEnv)
    const names = s.credentials?.envVars?.map(v => v.name)
    expect(names).toEqual(['GROQ_API_KEY', 'GROQ_API_KEYS', 'OPENAI_API_KEY'])
    // api.groq.com deduped despite two groq vars.
    expect(s.network?.allowedDomains).toEqual(['api.groq.com', 'api.openai.com'])
  })

  it('every masked credential uses mask mode and has an inject host', () => {
    const s = buildSandboxSettings({
      TELEGRAM_BOT_TOKEN: 't',
      ANTHROPIC_API_KEY: 'a',
    } as NodeJS.ProcessEnv)
    expect(s.credentials?.envVars?.length).toBe(2)
    for (const v of s.credentials!.envVars!) {
      expect(v.mode).toBe('mask')
      expect(v.injectHosts?.length).toBeGreaterThan(0)
    }
  })

  it('ignores an empty-string var (treated as absent)', () => {
    const s = buildSandboxSettings({ GROQ_API_KEY: '' } as NodeJS.ProcessEnv)
    expect(s.credentials).toBeUndefined()
  })
})
