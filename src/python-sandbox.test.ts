import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

// A fake project root with a secret in it, standing in for the real one with
// its .env files. The sandbox directory lives inside it, as it does in a bot.
const { PROJECT } = vi.hoisted(() => {
  const { mkdtempSync, realpathSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  return { PROJECT: realpathSync(mkdtempSync(join(tmpdir(), 'pysb-project-'))) }
})

vi.mock('./config.js', () => ({ PROJECT_ROOT: PROJECT }))
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { PythonSandbox, sandboxEnv, macProfile, bwrapArgs, hiddenRoots, chooseLauncher } from './python-sandbox.js'

const hasPython = spawnSync('python3', ['-c', 'pass']).status === 0

describe('sandboxEnv', () => {
  it('carries no secret from the bot environment', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.TELEGRAM_BOT_TOKEN = '1:test'
    const env = sandboxEnv('/sb')
    expect(Object.values(env).join(' ')).not.toMatch(/sk-test|1:test/)
    expect(Object.keys(env).sort()).toEqual(
      ['HOME', 'LANG', 'LC_ALL', 'MPLBACKEND', 'MPLCONFIGDIR', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED', 'TMPDIR'])
    expect(env.HOME).toBe('/sb')
  })
})

describe('macProfile', () => {
  const p = macProfile('/p/sb', { home: '/hh/x', projectRoot: '/p', readable: ['/hh/x/Library/Python'] })

  it('denies network and writes, then re-allows the sandbox', () => {
    expect(p).toContain('(deny network*)')
    expect(p.indexOf('(deny file-write*)')).toBeLessThan(p.indexOf('(allow file-write* (subpath "/p/sb")'))
  })

  it('hides home and project, keeping the sandbox and python paths readable', () => {
    expect(p).toContain('(deny file-read* (subpath "/hh/x") (subpath "/p"))')
    expect(p).toContain('(allow file-read* (subpath "/p/sb") (subpath "/hh/x/Library/Python"))')
  })

  it('escapes quotes in paths', () => {
    expect(macProfile('/a"b', { home: '/h', projectRoot: '/r' })).toContain('(subpath "/a\\"b")')
  })
})

describe('bwrapArgs / hiddenRoots', () => {
  it('unshares the network and binds only the sandbox writable', () => {
    const a = bwrapArgs('/srv/u/bot/sb', ['/srv'])
    expect(a).toContain('--unshare-all')
    expect(a.join(' ')).toContain('--tmpfs /srv')
    expect(a.join(' ')).toContain('--bind /srv/u/bot/sb /srv/u/bot/sb')
    expect(a.indexOf('--tmpfs')).toBeLessThan(a.indexOf('--bind'))
  })

  it('mounts read-only dirs after hiding their parents', () => {
    const a = bwrapArgs('/srv/u/sb', ['/srv'], ['/srv/u/uploads'])
    expect(a.join(' ')).toContain('--ro-bind /srv/u/uploads /srv/u/uploads')
    expect(a.lastIndexOf('--tmpfs')).toBeLessThan(a.indexOf('--ro-bind', 3))
  })

  it('drops paths already hidden by a parent', () => {
    expect(hiddenRoots(['/srv', '/root', '/srv/u/BotVa'])).toEqual(['/srv', '/root'])
    expect(hiddenRoots(['/srv', '/opt/botva'])).toEqual(['/srv', '/opt/botva'])
  })
})

// The first call imports matplotlib, which builds its font cache in the fresh
// MPLCONFIGDIR — slow once, so these tests get a generous timeout.
describe.skipIf(!hasPython)('PythonSandbox (real python3)', { timeout: 120_000 }, () => {
  const dir = join(PROJECT, 'workspace', 'sandbox')
  const outside = join(PROJECT, 'outside')
  const uploads = join(PROJECT, 'workspace', 'bot', 'uploads')
  let sb: PythonSandbox

  beforeAll(async () => {
    mkdirSync(outside, { recursive: true })
    mkdirSync(uploads, { recursive: true })
    writeFileSync(join(uploads, 'data.csv'), 'a,b\n1,2\n')
    writeFileSync(join(PROJECT, '.env'), 'SECRET=top\n')
    process.env.BOTVA_TEST_SECRET = 'leak-me'
    sb = new PythonSandbox(dir, 110_000, [uploads])
    await sb.execute('pass')
  }, 120_000)

  afterAll(() => {
    sb.kill()
    rmSync(PROJECT, { recursive: true, force: true })
  })

  it('runs code and keeps state between calls', async () => {
    expect((await sb.execute('x = 21')).error).toBeNull()
    expect((await sb.execute('print(x * 2)')).stdout.trim()).toBe('42')
  })

  it('does not see the bot environment', async () => {
    const r = await sb.execute('import os; print(os.environ.get("BOTVA_TEST_SECRET"), os.environ["HOME"])')
    expect(r.stdout).not.toContain('leak-me')
    expect(r.stdout).toContain(dir)
  })

  it('writes inside the sandbox', async () => {
    const r = await sb.execute('open("ok.txt", "w").write("1")')
    expect(r.error).toBeNull()
    expect(existsSync(join(dir, 'ok.txt'))).toBe(true)
  })

  it('still saves matplotlib figures', async () => {
    const r = await sb.execute('import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])')
    expect(r.error).toBeNull()
    expect(r.files.some(f => f.endsWith('figure_1.png'))).toBe(true)
  })

  const isolated = chooseLauncher(join(PROJECT, 'probe')).isolation !== 'env-only'

  it.skipIf(!isolated)('cannot write outside the sandbox', async () => {
    const r = await sb.execute(`open(${JSON.stringify(join(outside, 'x.txt'))}, "w").write("1")`)
    expect(r.error).toMatch(/PermissionError|Operation not permitted/)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })

  it.skipIf(!isolated)('cannot read the project secrets', async () => {
    const r = await sb.execute(`print(open(${JSON.stringify(join(PROJECT, '.env'))}).read())`)
    expect(r.stdout).not.toContain('SECRET=top')
    expect(r.error).toMatch(/PermissionError|Operation not permitted/)
  })

  it.skipIf(!isolated)('reads uploads but cannot change them', async () => {
    const csv = JSON.stringify(join(uploads, 'data.csv'))
    expect((await sb.execute(`print(open(${csv}).read().splitlines()[1])`)).stdout.trim()).toBe('1,2')
    expect((await sb.execute(`open(${csv}, "w").write("x")`)).error).toMatch(/PermissionError|Operation not permitted/)
  })

  it.skipIf(!isolated)('has no network', async () => {
    const r = await sb.execute('import socket\ns = socket.socket()\ns.settimeout(3)\ns.connect(("1.1.1.1", 53))')
    expect(r.error).toMatch(/PermissionError|Operation not permitted|OSError/)
  })
})
