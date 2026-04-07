import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compactSessionJsonl } from './session-compactor.js'

function jsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

function userMsg(text: string) {
  return {
    type: 'user',
    parentUuid: 'aaaa-bbbb',
    sessionId: '00000000-0000-0000-0000-000000000000',
    timestamp: '2026-01-01T00:00:00Z',
    cwd: '/some/cwd',
    version: '1.0.0',
    requestId: 'req-1',
    userType: 'external',
    gitBranch: 'main',
    message: { role: 'user', content: text },
  }
}

function assistantMsg(blocks: unknown[]) {
  return {
    type: 'assistant',
    parentUuid: 'aaaa-bbbb',
    sessionId: '00000000-0000-0000-0000-000000000000',
    timestamp: '2026-01-01T00:00:01Z',
    cwd: '/some/cwd',
    version: '1.0.0',
    requestId: 'req-1',
    userType: 'external',
    gitBranch: 'main',
    message: { role: 'assistant', content: blocks },
  }
}

function toolResultMsg(toolUseId: string, text: string, isError = false) {
  return {
    type: 'user',
    parentUuid: 'aaaa-bbbb',
    sessionId: '00000000-0000-0000-0000-000000000000',
    timestamp: '2026-01-01T00:00:02Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: text },
      ],
    },
  }
}

describe('compactSessionJsonl', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compactor-test-'))
    path = join(dir, 'session.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for missing file', () => {
    expect(compactSessionJsonl(join(dir, 'nope.jsonl'))).toBeNull()
  })

  it('parses user + assistant text, skips meta overhead', () => {
    writeFileSync(path, jsonl([
      userMsg('Привіт, як справи?'),
      assistantMsg([{ type: 'text', text: 'Все добре!' }]),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.turns).toEqual([
      { role: 'user', text: 'Привіт, як справи?' },
      { role: 'assistant', text: 'Все добре!' },
    ])
    expect(c.stats.totalTurns).toBe(2)
    expect(c.stats.toolCalls).toBe(0)
  })

  it('achieves ≥3× compression on a meta-heavy session', () => {
    const bigText = 'x'.repeat(100)
    const entries: unknown[] = []
    for (let i = 0; i < 10; i++) {
      entries.push(userMsg(`question ${i} ${bigText}`))
      entries.push(assistantMsg([{ type: 'text', text: `answer ${i}` }]))
    }
    writeFileSync(path, jsonl(entries))
    const c = compactSessionJsonl(path)!
    const ratio = c.stats.rawBytes / c.stats.compactedBytes
    expect(ratio).toBeGreaterThanOrEqual(3)
  })

  it('trims thinking blocks to 300 chars', () => {
    const longThinking = 'a'.repeat(1000)
    writeFileSync(path, jsonl([
      userMsg('do something substantial please'),
      assistantMsg([
        { type: 'thinking', thinking: longThinking },
        { type: 'text', text: 'done' },
      ]),
    ]))
    const c = compactSessionJsonl(path)!
    const assistant = c.turns.find((t) => t.role === 'assistant')!
    expect(assistant.thinking!.length).toBeLessThanOrEqual(301) // 300 + ellipsis
    expect(assistant.thinking!.startsWith('aaa')).toBe(true)
  })

  it('truncates long tool_result to 200 chars', () => {
    const bigResult = 'R'.repeat(5000)
    writeFileSync(path, jsonl([
      userMsg('find something big please, really big'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'Grep', input: { pattern: 'foo' } },
      ]),
      toolResultMsg('tool_1', bigResult),
    ]))
    const c = compactSessionJsonl(path)!
    const tool = c.turns[1].tools![0]
    expect(tool.name).toBe('Grep')
    expect(tool.result!.length).toBeLessThanOrEqual(201)
    expect(tool.ok).toBe(true)
  })

  it('marks error tool_result with [error: ...] and ok=false', () => {
    writeFileSync(path, jsonl([
      userMsg('please do a thing that might fail on us'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls /nope' } },
      ]),
      toolResultMsg('tool_1', 'no such file or directory', true),
    ]))
    const c = compactSessionJsonl(path)!
    const tool = c.turns[1].tools![0]
    expect(tool.ok).toBe(false)
    expect(tool.result!.startsWith('[error:')).toBe(true)
  })

  it('preserves SaveFact input in full (FULL_INPUT_TOOLS)', () => {
    const factArg = { text: 'User prefers tea over coffee', sector: 'preferences', kind: 'preference' }
    writeFileSync(path, jsonl([
      userMsg('remember that I prefer tea'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'SaveFact', input: factArg },
      ]),
      toolResultMsg('tool_1', 'saved'),
    ]))
    const c = compactSessionJsonl(path)!
    const tool = c.turns[1].tools![0]
    expect(tool.name).toBe('SaveFact')
    expect(tool.input).toContain('User prefers tea over coffee')
    expect(tool.input).toContain('preferences')
  })

  it('summarizes Write tool_use as file_path=...', () => {
    writeFileSync(path, jsonl([
      userMsg('update config file please do it now'),
      assistantMsg([
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'Write',
          input: { file_path: '/foo/bar.ts', content: 'very long content '.repeat(500) },
        },
      ]),
    ]))
    const c = compactSessionJsonl(path)!
    const tool = c.turns[1].tools![0]
    expect(tool.input).toBe('file_path=/foo/bar.ts')
  })

  it('truncates Bash command to 120 chars', () => {
    const longCmd = 'echo ' + 'x'.repeat(500)
    writeFileSync(path, jsonl([
      userMsg('run that long command for me please'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: longCmd } },
      ]),
    ]))
    const c = compactSessionJsonl(path)!
    const tool = c.turns[1].tools![0]
    expect(tool.input.length).toBeLessThanOrEqual(121)
  })

  it('marks session as trivial when no mutating tools and short user input', () => {
    writeFileSync(path, jsonl([
      userMsg('привіт'),
      assistantMsg([{ type: 'text', text: 'привіт!' }]),
      userMsg('дякую'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'SearchMemory', input: { query: 'foo' } },
        { type: 'text', text: 'знайшов' },
      ]),
      toolResultMsg('tool_1', 'no results'),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.stats.trivial).toBe(true)
  })

  it('treats SaveFact-only session as trivial (already consolidated inline)', () => {
    writeFileSync(path, jsonl([
      userMsg('hi'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'SaveFact', input: { text: 'a fact', sector: 'misc', kind: 'semantic' } },
      ]),
      toolResultMsg('tool_1', 'ok'),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.stats.trivial).toBe(true)
    // But SaveFact still visible in prompt (full input preserved) so the
    // consolidator can dedupe against existing facts.
    expect(c.turns[1].tools![0].input).toContain('a fact')
  })

  it('keeps session non-trivial when SaveFact is mixed with real mutating tools', () => {
    writeFileSync(path, jsonl([
      userMsg('hi'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'SaveFact', input: { text: 'a fact' } },
        { type: 'tool_use', id: 'tool_2', name: 'Write', input: { file_path: '/a.ts', content: 'x' } },
      ]),
      toolResultMsg('tool_1', 'ok'),
      toolResultMsg('tool_2', 'ok'),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.stats.trivial).toBe(false)
  })

  it('treats DeleteFact/BoostFact as already-consolidated (trivial when alone)', () => {
    writeFileSync(path, jsonl([
      userMsg('hi'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'DeleteFact', input: { id: 42 } },
        { type: 'tool_use', id: 'tool_2', name: 'BoostFact', input: { id: 7 } },
      ]),
      toolResultMsg('tool_1', 'ok'),
      toolResultMsg('tool_2', 'ok'),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.stats.trivial).toBe(true)
  })

  it('marks session as non-trivial when a real mutating tool is present (e.g. Write)', () => {
    writeFileSync(path, jsonl([
      userMsg('hi'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'Write', input: { file_path: '/foo.ts', content: 'x' } },
      ]),
      toolResultMsg('tool_1', 'ok'),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.stats.trivial).toBe(false)
  })

  it('marks session as non-trivial when user message is long', () => {
    writeFileSync(path, jsonl([
      userMsg('x'.repeat(200)),
      assistantMsg([{ type: 'text', text: 'ok' }]),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.stats.trivial).toBe(false)
  })

  it('recognizes mutating git commands in Bash', () => {
    writeFileSync(path, jsonl([
      userMsg('commit it'),
      assistantMsg([
        { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'git commit -m "fix"' } },
      ]),
      toolResultMsg('tool_1', '[main 1234] fix'),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.stats.trivial).toBe(false)
  })

  it('strips injected Memory context prefix from user message', () => {
    writeFileSync(path, jsonl([
      userMsg('[Memory context]\nUser name is Foo\n\nReal question here'),
      assistantMsg([{ type: 'text', text: 'answer' }]),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.turns[0].text).toBe('Real question here')
  })

  it('ignores system/queue-operation/custom-title entries', () => {
    writeFileSync(path, jsonl([
      { type: 'system', content: 'should be ignored' },
      { type: 'queue-operation', op: 'whatever' },
      { type: 'custom-title', customTitle: 'T' },
      { type: 'file-history-snapshot', data: '...' },
      userMsg('real question here now'),
      assistantMsg([{ type: 'text', text: 'real answer' }]),
    ]))
    const c = compactSessionJsonl(path)!
    expect(c.turns).toHaveLength(2)
    expect(c.turns[0].role).toBe('user')
    expect(c.turns[1].role).toBe('assistant')
  })

  it('handles malformed JSON lines gracefully', () => {
    const good = JSON.stringify(userMsg('hello'))
    writeFileSync(path, good + '\n{not json\n' + JSON.stringify(assistantMsg([{ type: 'text', text: 'hi' }])) + '\n')
    const c = compactSessionJsonl(path)!
    expect(c.turns).toHaveLength(2)
  })
})
