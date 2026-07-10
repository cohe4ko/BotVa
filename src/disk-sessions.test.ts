import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { getClaudeProjectDir, selectUndoAnchor } from './disk-sessions.js'

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
    expect(typeof mod.selectUndoAnchor).toBe('function')
    expect(typeof mod.computeUndoAnchor).toBe('function')
  })
})

// Helpers to build fake session JSONL lines (mirrors real Claude Code structure)
const userPrompt = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, promptSource: 'sdk', message: { content: text } })
const toolResult = (uuid: string, id: string) =>
  JSON.stringify({ type: 'user', uuid, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const assistant = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } })
const meta = () => JSON.stringify({ type: 'queue-operation', operation: 'x' })

describe('selectUndoAnchor', () => {
  it('returns none when there are no real user messages', () => {
    const jsonl = [meta(), assistant('a1', 'hi')].join('\n')
    expect(selectUndoAnchor(jsonl)).toEqual({ action: 'none' })
  })

  it('returns clear when there is only one real user message', () => {
    const jsonl = [userPrompt('u1', 'hello'), assistant('a1', 'hi there')].join('\n')
    expect(selectUndoAnchor(jsonl)).toEqual({ action: 'clear' })
  })

  it('anchors at the assistant message before the last real user prompt', () => {
    const jsonl = [
      userPrompt('u1', 'first question'),
      assistant('a1', 'first answer'),
      userPrompt('u2', 'second question'),
      assistant('a2', 'second answer'),
    ].join('\n')
    const res = selectUndoAnchor(jsonl)
    expect(res).toEqual({ action: 'anchor', anchorUuid: 'a1', removedPreview: 'second question' })
  })

  it('skips tool_result user entries when counting real user turns', () => {
    // A single real prompt whose turn contains interleaved tool_result "user" entries.
    const jsonl = [
      userPrompt('u1', 'do a thing'),
      assistant('a1', 'let me check'),
      toolResult('tr1', 'call1'),
      assistant('a2', 'done'),
    ].join('\n')
    // Only one real user turn → clearing, not anchoring.
    expect(selectUndoAnchor(jsonl)).toEqual({ action: 'clear' })
  })

  it('anchors at the last assistant of the previous turn across tool calls', () => {
    const jsonl = [
      userPrompt('u1', 'q1'),
      assistant('a1', 'thinking'),
      toolResult('tr1', 'c1'),
      assistant('a2', 'answer 1'),
      userPrompt('u2', 'q2'),
      assistant('a3', 'answer 2'),
    ].join('\n')
    const res = selectUndoAnchor(jsonl)
    expect(res).toMatchObject({ action: 'anchor', anchorUuid: 'a2' })
  })

  it('ignores blank and malformed lines', () => {
    const jsonl = ['', 'not json', userPrompt('u1', 'a'), assistant('a1', 'b'), userPrompt('u2', 'c'), '', assistant('a2', 'd')].join('\n')
    expect(selectUndoAnchor(jsonl)).toMatchObject({ action: 'anchor', anchorUuid: 'a1' })
  })
})
