import { describe, it, expect } from 'vitest'
import { buildRestrictedOptions, builtinToolId, builtinToolsOf, isToolAllowed } from './run-restrictions.js'
import { guestRestrictions, GUEST_ALLOWED_TOOLS } from './guest-mode.js'

const WRITE_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']

async function hookDecision(opts: ReturnType<typeof buildRestrictedOptions>, toolName: string) {
  const hook = opts.hooks.PreToolUse[0].hooks[0]
  return (await hook({ tool_name: toolName })).decision
}

describe('isToolAllowed', () => {
  it('matches exact names', () => {
    expect(isToolAllowed('WebSearch', ['WebSearch'])).toBe(true)
    expect(isToolAllowed('mcp__builtin__SearchMemory', ['mcp__builtin__SearchMemory'])).toBe(true)
    expect(isToolAllowed('mcp__builtin__SaveFact', ['mcp__builtin__SearchMemory'])).toBe(false)
  })

  it('expands a server wildcard to that server only', () => {
    expect(isToolAllowed('mcp__calendar__list', ['mcp__calendar__*'])).toBe(true)
    expect(isToolAllowed('mcp__calendarx__list', ['mcp__calendar__*'])).toBe(false)
    expect(isToolAllowed('mcp__telegram__tg_send_message', ['mcp__calendar__*'])).toBe(false)
  })

  it('never allows a write tool, even when listed', () => {
    for (const t of WRITE_TOOLS) expect(isToolAllowed(t, [t])).toBe(false)
  })

  it('rejects an empty name', () => {
    expect(isToolAllowed('', ['WebSearch'])).toBe(false)
  })
})

describe('buildRestrictedOptions', () => {
  const opts = buildRestrictedOptions({ allowTools: ['WebSearch', 'Bash', builtinToolId('SearchMemory')] })

  it('offers only the listed built-ins, minus write tools', () => {
    expect(opts.tools).toEqual(['WebSearch'])
    expect(builtinToolsOf(['Read', 'mcp__x__y', 'Edit'])).toEqual(['Read'])
  })

  it('denies anything not pre-approved instead of bypassing', () => {
    expect(opts.permissionMode).toBe('dontAsk')
    expect(opts.allowDangerouslySkipPermissions).toBe(false)
    expect(opts.allowedTools).not.toContain('Bash')
  })

  it('blocks in the hook what the allowlist does not name', async () => {
    expect(await hookDecision(opts, 'WebSearch')).toBe('approve')
    expect(await hookDecision(opts, 'mcp__builtin__SearchMemory')).toBe('approve')
    expect(await hookDecision(opts, 'Bash')).toBe('block')
    expect(await hookDecision(opts, 'Read')).toBe('block')
    expect(await hookDecision(opts, 'mcp__builtin__SendEmail')).toBe('block')
    expect(await hookDecision(opts, 'mcp__telegram__tg_send_message')).toBe('block')
  })
})

describe('guestRestrictions', () => {
  const opts = buildRestrictedOptions(guestRestrictions())

  it('allows every advertised guest tool', async () => {
    expect(opts.tools).toEqual(['WebSearch', 'WebFetch'])
    for (const t of GUEST_ALLOWED_TOOLS) {
      const id = t.startsWith('Web') ? t : builtinToolId(t)
      expect(await hookDecision(opts, id)).toBe('approve')
    }
  })

  it('allows nothing that acts on the world', async () => {
    for (const t of [...WRITE_TOOLS, 'Read', 'Glob', 'Grep']) expect(await hookDecision(opts, t)).toBe('block')
    for (const t of ['SendMedia', 'SendEmail', 'CreateReminder', 'WriteWorkspaceFile', 'RunPython', 'SaveFact']) {
      expect(await hookDecision(opts, builtinToolId(t))).toBe('block')
    }
  })
})
