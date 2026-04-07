import { describe, it, expect, vi } from 'vitest'

vi.mock('./config.js', () => ({
  STORE_DIR: '/tmp/botva-test',
  BOT_NAME: 'TestBot',
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { shouldUseTelegraph, markdownToNodes } from './telegraph.js'

describe('shouldUseTelegraph', () => {
  it('returns false for short text', () => {
    expect(shouldUseTelegraph('Hello world')).toBe(false)
  })

  it('returns false for text at threshold', () => {
    const text = 'a'.repeat(2000)
    expect(shouldUseTelegraph(text)).toBe(false)
  })

  it('returns true for text over threshold', () => {
    const text = 'a'.repeat(2001)
    expect(shouldUseTelegraph(text)).toBe(true)
  })
})

describe('markdownToNodes — tables', () => {
  it('renders simple table with header and data rows', () => {
    const md = `| Name | Age |
|------|-----|
| Alice | 30 |
| Bob | 25 |`
    const nodes = markdownToNodes(md)
    // Header row as bold
    expect(nodes[0]).toEqual({ tag: 'p', children: [{ tag: 'b', children: ['Name  ·  Age'] }] })
    // Data rows with key-value format
    expect(nodes[1]).toEqual({
      tag: 'p',
      children: [
        { tag: 'b', children: ['Name: '] }, 'Alice',
        '  |  ',
        { tag: 'b', children: ['Age: '] }, '30',
      ],
    })
    expect(nodes[2]).toEqual({
      tag: 'p',
      children: [
        { tag: 'b', children: ['Name: '] }, 'Bob',
        '  |  ',
        { tag: 'b', children: ['Age: '] }, '25',
      ],
    })
  })

  it('preserves empty cells with correct column alignment', () => {
    const md = `| A | B | C |
|---|---|---|
| x |   | z |`
    const nodes = markdownToNodes(md)
    // Data row: empty cell B should render as — , C should stay aligned
    const dataRow = nodes[1] as { tag: string; children: unknown[] }
    expect(dataRow.children).toEqual([
      { tag: 'b', children: ['A: '] }, 'x',
      '  |  ',
      { tag: 'b', children: ['B: '] }, '—',
      '  |  ',
      { tag: 'b', children: ['C: '] }, 'z',
    ])
  })

  it('renders table without header (no separator row)', () => {
    const md = `| foo | bar |
| baz | qux |`
    const nodes = markdownToNodes(md)
    // No bold header, just plain cell values
    expect(nodes[0]).toEqual({ tag: 'p', children: ['foo  |  bar'] })
    expect(nodes[1]).toEqual({ tag: 'p', children: ['baz  |  qux'] })
  })

  it('does not leak headers between separate tables', () => {
    const md = `| H1 | H2 |
|----|----|
| a | b |

Some text

| X | Y |
|---|---|
| c | d |`
    const nodes = markdownToNodes(md)
    // Find second table's data row — should use X/Y headers, not H1/H2
    const secondDataRow = nodes.find(
      (n): n is Extract<typeof n, { tag: string; children?: unknown }> =>
        typeof n === 'object' && n !== null && 'children' in n &&
        Array.isArray((n as { children: unknown[] }).children) &&
        (n as { children: unknown[] }).children.some((c: unknown) =>
          typeof c === 'object' && c !== null && 'children' in c &&
          Array.isArray((c as { children: unknown[] }).children) &&
          (c as { children: unknown[] }).children[0] === 'X: '
        )
    )
    expect(secondDataRow).toBeDefined()
  })
})
