import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { tmpRoot } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { tmpRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'botva-voice-test-')) }
})

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    GROQ_STT_MODEL: 'whisper-large-v3',
    GROQ_STT_PROMPT: 'test prompt',
  })),
  BOT_NAME: 'test-bot',
  BOT_DIR: tmpRoot,
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./groq-keys.js', () => ({
  pickKey: vi.fn(() => ({ id: 'k1', label: 'test', key: 'gsk_test' })),
  markUsed: vi.fn(),
  markRateLimited: vi.fn(),
  markError: vi.fn(),
  parseRetryAfter: vi.fn(() => 60),
  ensureMigrated: vi.fn(),
  hasAnyKey: vi.fn(() => true),
  hasUsableKey: vi.fn(() => true),
  loadStore: vi.fn(() => ({ keys: [{ id: 'k1' }] })),
}))

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: spawnMock }
})

import { transcribeAudioLong } from './voice.js'
import { EventEmitter } from 'events'

function fakeProcess(stdout: string, stderr: string, code: number, onClose?: () => void): EventEmitter {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout))
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr))
    onClose?.()
    proc.emit('close', code)
  })
  return proc
}

const origFetch = global.fetch
afterAll(() => {
  global.fetch = origFetch
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  spawnMock.mockReset()
  vi.restoreAllMocks()
})

describe('transcribeAudioLong', () => {
  it('rejects when file does not exist', async () => {
    await expect(transcribeAudioLong('/no/such/file.ogg')).rejects.toThrow(/not found/i)
  })

  it('uploads small supported file directly without splitting', async () => {
    const file = join(tmpRoot, 'small.ogg')
    writeFileSync(file, Buffer.alloc(1024)) // 1 KB

    spawnMock.mockImplementation((cmd: string) => {
      if (cmd === 'ffprobe') return fakeProcess('12.5\n', '', 0)
      throw new Error(`unexpected spawn: ${cmd}`)
    })

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ text: 'hello world', duration: 12.5 }),
      text: async () => '',
    }) as any) as any

    const r = await transcribeAudioLong(file)
    expect(r.text).toBe('hello world')
    expect(r.chunks).toBe(1)
    expect(r.bytes).toBe(1024)
    expect(r.durationSec).toBe(12.5)
    // No ffmpeg split call
    const ffmpegCalls = spawnMock.mock.calls.filter(c => c[0] === 'ffmpeg')
    expect(ffmpegCalls.length).toBe(0)
  })

  it('re-encodes & chunks when file is oversized, joins transcripts', async () => {
    const file = join(tmpRoot, 'big.wav')
    // Write a 25 MB + 1 byte file to exceed GROQ_FILE_LIMIT_BYTES (24 MB).
    writeFileSync(file, Buffer.alloc(25 * 1024 * 1024 + 1))

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeProcess('3000\n', '', 0)
      if (cmd === 'ffmpeg' && args.includes('-version')) return fakeProcess('ffmpeg 8.0', '', 0)
      if (cmd === 'ffmpeg') {
        // Find the output pattern arg (last one)
        const pattern = args[args.length - 1] as string
        const dir = pattern.replace(/\/chunk_%04d\.flac$/, '')
        return fakeProcess('', '', 0, () => {
          // Create two fake chunk files in the temp dir
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'chunk_0000.flac'), Buffer.alloc(100))
          writeFileSync(join(dir, 'chunk_0001.flac'), Buffer.alloc(100))
        })
      }
      throw new Error(`unexpected spawn: ${cmd}`)
    })

    let call = 0
    global.fetch = vi.fn(async () => {
      call++
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ text: `part ${call}`, duration: 1500 }),
        text: async () => '',
      } as any
    }) as any

    const r = await transcribeAudioLong(file)
    expect(r.chunks).toBe(2)
    expect(r.text).toBe('part 1 part 2')
    expect(r.durationSec).toBe(3000)
    expect(call).toBe(2)
    // ffmpeg -version + ffmpeg split
    const ffmpegCalls = spawnMock.mock.calls.filter(c => c[0] === 'ffmpeg')
    expect(ffmpegCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('chunks unsupported format even if small', async () => {
    const file = join(tmpRoot, 'weird.amr')
    writeFileSync(file, Buffer.alloc(1024))

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeProcess('30\n', '', 0)
      if (cmd === 'ffmpeg' && args.includes('-version')) return fakeProcess('ffmpeg', '', 0)
      if (cmd === 'ffmpeg') {
        const pattern = args[args.length - 1] as string
        const dir = pattern.replace(/\/chunk_%04d\.flac$/, '')
        return fakeProcess('', '', 0, () => {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'chunk_0000.flac'), Buffer.alloc(50))
        })
      }
      throw new Error(`unexpected spawn: ${cmd}`)
    })

    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ text: 'amr text', duration: 30 }),
      text: async () => '',
    }) as any) as any

    const r = await transcribeAudioLong(file)
    expect(r.text).toBe('amr text')
    expect(r.chunks).toBe(1) // one chunk produced
  })

  it('errors clearly when oversized and ffmpeg is missing', async () => {
    const file = join(tmpRoot, 'big2.wav')
    writeFileSync(file, Buffer.alloc(25 * 1024 * 1024 + 1))

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeProcess('3000\n', '', 0)
      if (cmd === 'ffmpeg' && args.includes('-version')) return fakeProcess('', 'not found', 127)
      throw new Error(`unexpected spawn: ${cmd}`)
    })

    await expect(transcribeAudioLong(file)).rejects.toThrow(/ffmpeg is not installed/i)
  })

  it('cleans up chunk temp dir after success', async () => {
    const file = join(tmpRoot, 'big3.wav')
    writeFileSync(file, Buffer.alloc(25 * 1024 * 1024 + 1))

    let chunkDir = ''
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeProcess('1500\n', '', 0)
      if (cmd === 'ffmpeg' && args.includes('-version')) return fakeProcess('ffmpeg', '', 0)
      if (cmd === 'ffmpeg') {
        const pattern = args[args.length - 1] as string
        chunkDir = pattern.replace(/\/chunk_%04d\.flac$/, '')
        return fakeProcess('', '', 0, () => {
          if (!existsSync(chunkDir)) mkdirSync(chunkDir, { recursive: true })
          writeFileSync(join(chunkDir, 'chunk_0000.flac'), Buffer.alloc(100))
        })
      }
      throw new Error(`unexpected spawn: ${cmd}`)
    })

    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ text: 'ok', duration: 1500 }),
      text: async () => '',
    }) as any) as any

    await transcribeAudioLong(file)
    expect(chunkDir).toBeTruthy()
    expect(existsSync(chunkDir)).toBe(false)
  })
})
