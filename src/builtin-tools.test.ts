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

// Mock the Agent SDK so tool() just returns the definition (name/handler) and
// createSdkMcpServer echoes its config — lets us extract handlers and invoke them.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (cfg: unknown) => cfg,
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

import { getBuiltinToolDefs, isToolEnabled, createBuiltinMcpServer, type BuiltinToolDef } from './builtin-tools.js'

// Helper: build the MCP server with a fake grammy Context and return the tool map
async function buildTools(overrides: { askUser?: any } = {}) {
  const reply = vi.fn().mockResolvedValue(undefined)
  const setMessageReaction = vi.fn().mockResolvedValue(true)
  const ctx: any = {
    message: { message_id: 42 },
    reply,
    replyWithChatAction: vi.fn().mockResolvedValue(undefined),
    api: { setMessageReaction },
  }
  const askUser = overrides.askUser ?? vi.fn().mockResolvedValue('Option A')
  const result: any = await createBuiltinMcpServer(ctx, 123, askUser)
  const tools: any[] = result.server.tools
  const find = (n: string) => tools.find(t => t.name === n)
  return { ctx, reply, setMessageReaction, askUser, tools, find }
}

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

describe('getBuiltinToolDefs — new tools', () => {
  it('includes SendChecklist (telegram, enabled)', () => {
    const def = getBuiltinToolDefs().find(d => d.name === 'SendChecklist')
    expect(def).toBeTruthy()
    expect(def!.category).toBe('telegram')
    expect(def!.enabled).toBe(true)
  })
})

describe('SendChecklist handler', () => {
  it('sends an HTML message with markdown checkboxes', async () => {
    const { reply, find } = await buildTools()
    const t = find('SendChecklist')
    expect(t).toBeTruthy()
    const res = await t.handler({ title: 'Покупки', tasks: ['Молоко', 'Хліб'] }, {})
    expect(res.isError).toBeFalsy()
    expect(reply).toHaveBeenCalledTimes(1)
    const [text, opts] = reply.mock.calls[0]
    expect(opts.parse_mode).toBe('HTML')
    expect(text).toContain('Покупки')
    expect(text).toContain('- [ ] Молоко')
    expect(text).toContain('- [ ] Хліб')
  })

  it('escapes HTML in title and tasks', async () => {
    const { reply, find } = await buildTools()
    const res = await find('SendChecklist').handler({ title: 'A & B', tasks: ['<b>x</b>'] }, {})
    expect(res.isError).toBeFalsy()
    const [text] = reply.mock.calls[0]
    expect(text).toContain('A &amp; B')
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('errors when all tasks are blank', async () => {
    const { reply, find } = await buildTools()
    const res = await find('SendChecklist').handler({ title: 'X', tasks: ['   ', ''] }, {})
    expect(res.isError).toBe(true)
    expect(reply).not.toHaveBeenCalled()
  })
})

describe('SetReaction handler', () => {
  it('sets an emoji reaction', async () => {
    const { setMessageReaction, find } = await buildTools()
    const res = await find('SetReaction').handler({ emoji: '🔥', remove: false }, {})
    expect(res.isError).toBeFalsy()
    expect(setMessageReaction).toHaveBeenCalledWith(123, 42, [{ type: 'emoji', emoji: '🔥' }])
  })

  it('removes the reaction with empty list when remove=true', async () => {
    const { setMessageReaction, find } = await buildTools()
    const res = await find('SetReaction').handler({ remove: true }, {})
    expect(res.isError).toBeFalsy()
    expect(setMessageReaction).toHaveBeenCalledWith(123, 42, [])
  })

  it('errors when neither emoji nor remove is given', async () => {
    const { setMessageReaction, find } = await buildTools()
    const res = await find('SetReaction').handler({ remove: false }, {})
    expect(res.isError).toBe(true)
    expect(setMessageReaction).not.toHaveBeenCalled()
  })
})

describe('AskUser handler — poll option media', () => {
  it('forwards per-option image through to the askUser callback', async () => {
    const askUser = vi.fn().mockResolvedValue('A')
    const { find } = await buildTools({ askUser })
    const t = find('AskUser')
    expect(t).toBeTruthy()
    await t.handler({
      question: 'Pick',
      options: [{ label: 'A', image: '/tmp/a.png' }, { label: 'B' }],
      keyboard: 'poll',
      multiple: false,
    }, {})
    expect(askUser).toHaveBeenCalledTimes(1)
    const passedOptions = askUser.mock.calls[0][1]
    expect(passedOptions[0].image).toBe('/tmp/a.png')
    expect(passedOptions[1].image).toBeUndefined()
  })
})
