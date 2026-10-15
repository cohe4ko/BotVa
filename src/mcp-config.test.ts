import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-mcp-test-'))
})

const mcpFile = join(testDir, 'mcp-servers.json')

// Mock the module-level constants
vi.mock('url', async (importOriginal) => {
  const orig = await importOriginal<typeof import('url')>()
  return {
    ...orig,
    fileURLToPath: () => join(testDir, 'src', 'fake.ts'),
  }
})

vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}))

import {
  getMcpServersConfig,
  setServerEnabled,
  isServerDisabled,
  addMcpServer,
  removeMcpServer,
  getMcpServer,
  type McpServerConfig,
} from './mcp-config.js'

beforeEach(() => {
  // Write a clean test config
  const config: Record<string, McpServerConfig> = {
    'test-server': {
      command: 'node',
      args: ['server.js'],
      enabled: true,
    },
    'disabled-server': {
      command: 'python',
      args: ['main.py'],
      enabled: false,
    },
    'env-server': {
      command: 'node',
      args: ['api.js'],
      envVars: ['API_KEY'],
      enabled: true,
    },
    'file-server': {
      command: 'node',
      args: ['obs.js'],
      requiresFile: ['store/telegram.session'],
      enabled: true,
    },
  }
  writeFileSync(mcpFile, JSON.stringify(config, null, 2))
})

describe('getMcpServersConfig', () => {
  it('returns all servers from config', () => {
    const servers = getMcpServersConfig()
    expect(servers.length).toBeGreaterThanOrEqual(3)
  })

  it('marks disabled server as not enabled', () => {
    const servers = getMcpServersConfig()
    const disabled = servers.find(s => s.name === 'disabled-server')
    expect(disabled?.enabled).toBe(false)
    expect(disabled?.userEnabled).toBe(false)
  })

  it('server with missing envVars is not enabled', () => {
    const servers = getMcpServersConfig()
    const envServer = servers.find(s => s.name === 'env-server')
    expect(envServer?.enabled).toBe(false) // API_KEY not in env
    expect(envServer?.userEnabled).toBe(true) // user toggle is on
    expect(envServer?.condition).toBe('API_KEY')
  })

  it('server with satisfied envVars is enabled', () => {
    const servers = getMcpServersConfig({ API_KEY: 'test-key' })
    const envServer = servers.find(s => s.name === 'env-server')
    expect(envServer?.enabled).toBe(true)
  })
})

describe('setServerEnabled', () => {
  it('disables a server', () => {
    setServerEnabled('test-server', false)
    expect(isServerDisabled('test-server')).toBe(true)
  })

  it('enables a server', () => {
    setServerEnabled('disabled-server', true)
    expect(isServerDisabled('disabled-server')).toBe(false)
  })
})

describe('addMcpServer / removeMcpServer', () => {
  it('adds new server', () => {
    addMcpServer('new-server', { command: 'npx', args: ['new'], enabled: true })
    const server = getMcpServer('new-server')
    expect(server).not.toBeNull()
    expect(server!.command).toBe('npx')
  })

  it('removes server', () => {
    removeMcpServer('test-server')
    expect(getMcpServer('test-server')).toBeNull()
  })
})

describe('getMcpServer', () => {
  it('returns null for non-existent', () => {
    expect(getMcpServer('nonexistent')).toBeNull()
  })

  it('returns config for existing', () => {
    const server = getMcpServer('test-server')
    expect(server).not.toBeNull()
    expect(server!.command).toBe('node')
  })
})

describe('servers gated on a file rather than a setting', () => {
  const sessionPath = join(testDir, 'store', 'telegram.session')

  beforeEach(() => {
    rmSync(join(testDir, 'store'), { recursive: true, force: true })
  })

  it('withholds the server until the thing has actually been set up', () => {
    // Nothing was connected, so the tools must not exist at all — an agent
    // should never be offered a capability it cannot use.
    const s = getMcpServersConfig().find(x => x.name === 'file-server')
    expect(s?.enabled).toBe(false)
    expect(s?.userEnabled).toBe(true)
  })

  it('offers it once the session file is there', () => {
    mkdirSync(join(testDir, 'store'), { recursive: true })
    writeFileSync(sessionPath, 'session')
    expect(getMcpServersConfig().find(x => x.name === 'file-server')?.enabled).toBe(true)
  })

  it('keeps it through a connection loss, because the file outlives one', () => {
    // The marker is deliberately the session file and not the socket: a dropped
    // connection or a restarting daemon must not make the tools vanish.
    mkdirSync(join(testDir, 'store'), { recursive: true })
    writeFileSync(sessionPath, 'session')
    rmSync(join(testDir, 'store', 'telegram.sock'), { force: true })
    expect(getMcpServersConfig().find(x => x.name === 'file-server')?.enabled).toBe(true)
  })

  it('names the condition in a way a person can read', () => {
    expect(getMcpServersConfig().find(x => x.name === 'file-server')?.condition)
      .toBe('Telegram підключено')
  })

  it('leaves servers without the requirement alone', () => {
    expect(getMcpServersConfig().find(x => x.name === 'test-server')?.enabled).toBe(true)
  })
})
