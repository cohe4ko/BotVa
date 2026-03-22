import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// --- Mocks ---

const testDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  return mkdtempSync(join(tmpdir(), 'botva-media-test-'))
})

vi.mock('./config.js', () => ({
  PROJECT_ROOT: testDir,
  BOT_NAME: 'test-bot',
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  UPLOADS_DIR,
  ensureUploadsDir,
  downloadMedia,
  buildPhotoMessage,
  buildDocumentMessage,
  buildVideoMessage,
  cleanupOldUploads,
} from './media.js'

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ok */ }
})

// --- Tests ---

describe('UPLOADS_DIR', () => {
  it('resolves to workspace/<botName>/uploads', () => {
    expect(UPLOADS_DIR).toContain('workspace')
    expect(UPLOADS_DIR).toContain('test-bot')
    expect(UPLOADS_DIR).toContain('uploads')
  })
})

describe('ensureUploadsDir', () => {
  it('creates uploads directory', () => {
    ensureUploadsDir()
    const { existsSync } = require('fs')
    expect(existsSync(UPLOADS_DIR)).toBe(true)
  })

  it('does not throw if directory already exists', () => {
    ensureUploadsDir()
    expect(() => ensureUploadsDir()).not.toThrow()
  })
})

describe('downloadMedia', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    ensureUploadsDir()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('downloads file and returns local path', async () => {
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { file_path: 'photos/test.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => '8' },
        arrayBuffer: async () => new ArrayBuffer(8),
      })

    const path = await downloadMedia('BOT_TOKEN', 'file-123', 'photo.jpg')
    expect(path).toContain(UPLOADS_DIR)
    expect(path).toContain('photo.jpg')

    // Verify fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toContain('getFile?file_id=file-123')
    expect(mockFetch.mock.calls[1][0]).toContain('photos/test.jpg')
  })

  it('uses extension from remote path when no filename', async () => {
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { file_path: 'documents/file.pdf' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => '4' },
        arrayBuffer: async () => new ArrayBuffer(4),
      })

    const path = await downloadMedia('TOKEN', 'file-456')
    expect(path).toContain('file.pdf')
  })

  it('throws when getFile returns ok=false', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: false, error_code: 400 }),
    })

    await expect(downloadMedia('BAD_TOKEN', 'file-789')).rejects.toThrow('Failed to get file info')
  })

  it('throws when download fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { file_path: 'photos/x.jpg' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })

    await expect(downloadMedia('TOKEN', 'file-000')).rejects.toThrow('Failed to download file: 404')
  })

  it('sanitizes filename with special characters', async () => {
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { file_path: 'docs/a.txt' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => '2' },
        arrayBuffer: async () => new ArrayBuffer(2),
      })

    const path = await downloadMedia('TOKEN', 'file-1', 'файл із пробілами.txt')
    // Special chars replaced with dashes
    expect(path).not.toContain('файл')
    expect(path).toContain('.txt')
  })
})

describe('buildPhotoMessage', () => {
  it('builds message without caption', () => {
    const msg = buildPhotoMessage('/path/to/photo.jpg')
    expect(msg).toContain('Photo received')
    expect(msg).toContain('/path/to/photo.jpg')
    expect(msg).toContain('analyze this image')
    expect(msg).not.toContain('Caption')
  })

  it('builds message with caption', () => {
    const msg = buildPhotoMessage('/path/to/photo.jpg', 'My cat')
    expect(msg).toContain('Caption: My cat')
  })
})

describe('buildDocumentMessage', () => {
  it('builds message with filename', () => {
    const msg = buildDocumentMessage('/path/report.pdf', 'report.pdf')
    expect(msg).toContain('Document received: report.pdf')
    expect(msg).toContain('read and process')
  })

  it('includes caption when provided', () => {
    const msg = buildDocumentMessage('/path/doc.pdf', 'doc.pdf', 'Please review')
    expect(msg).toContain('Caption: Please review')
  })
})

describe('buildVideoMessage', () => {
  it('builds message without caption', () => {
    const msg = buildVideoMessage('/path/video.mp4')
    expect(msg).toContain('Video received')
    expect(msg).toContain('analyze this video')
  })

  it('builds message with caption', () => {
    const msg = buildVideoMessage('/path/video.mp4', 'Funny clip')
    expect(msg).toContain('Caption: Funny clip')
  })
})

describe('cleanupOldUploads', () => {
  it('removes files older than maxAge', () => {
    ensureUploadsDir()

    // Create an "old" file
    const oldFile = join(UPLOADS_DIR, 'old_file.txt')
    writeFileSync(oldFile, 'old data')
    // Set mtime to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(oldFile, twoDaysAgo, twoDaysAgo)

    // Create a "new" file
    const newFile = join(UPLOADS_DIR, 'new_file.txt')
    writeFileSync(newFile, 'new data')

    cleanupOldUploads(24 * 60 * 60 * 1000) // 24h

    const remaining = readdirSync(UPLOADS_DIR)
    expect(remaining).toContain('new_file.txt')
    expect(remaining).not.toContain('old_file.txt')
  })

  it('does not throw when uploads dir does not exist', () => {
    // Point to non-existent dir — function catches the error
    expect(() => cleanupOldUploads()).not.toThrow()
  })
})
