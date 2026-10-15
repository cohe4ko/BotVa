import { writeFileSync, createWriteStream, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'
import { PROJECT_ROOT, BOT_NAME } from './config.js'
import { logger } from './logger.js'

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB Telegram limit

export const UPLOADS_DIR = resolve(PROJECT_ROOT, 'workspace', BOT_NAME, 'uploads')

export function ensureUploadsDir(): void {
  mkdirSync(UPLOADS_DIR, { recursive: true })
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string
): Promise<string> {
  ensureUploadsDir()

  // Get file path from Telegram
  const fileInfoRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
  )
  const fileInfo = await fileInfoRes.json() as { ok: boolean; result: { file_path: string } }
  if (!fileInfo.ok) throw new Error('Failed to get file info from Telegram')

  const remotePath = fileInfo.result.file_path

  // Download the file
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${remotePath}`
  )
  if (!fileRes.ok) throw new Error(`Failed to download file: ${fileRes.status}`)

  const contentLength = Number(fileRes.headers.get('content-length') || 0)
  if (contentLength > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${Math.round(contentLength / 1024 / 1024)}MB exceeds 50MB limit`)
  }

  const ext = remotePath.includes('.') ? remotePath.slice(remotePath.lastIndexOf('.')) : ''
  const safeName = originalFilename ? sanitizeFilename(originalFilename) : `file${ext}`
  const localPath = join(UPLOADS_DIR, `${Date.now()}_${safeName}`)

  // Stream large files to disk instead of buffering in memory
  if (contentLength > 10 * 1024 * 1024 && fileRes.body) {
    await pipeline(Readable.fromWeb(fileRes.body as any), createWriteStream(localPath))
    logger.info({ localPath, size: contentLength }, 'Media streamed to disk')
  } else {
    const buffer = Buffer.from(await fileRes.arrayBuffer())
    writeFileSync(localPath, buffer)
    logger.info({ localPath, size: buffer.length }, 'Media downloaded')
  }
  return localPath
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`[Photo received. File saved at: ${localPath}]`]
  if (caption) parts.push(`Caption: ${caption}`)
  parts.push('Please analyze this image.')
  return parts.join('\n')
}

// One downloaded item of a Telegram album (media_group). Order matches the
// order the messages arrived from Telegram.
export type AlbumItem = {
  path: string
  kind: 'photo' | 'document' | 'video'
  filename?: string
}

// Build a single prompt describing a whole album (5-6 photos + one caption)
// so the agent sees one coherent block with one instruction instead of N
// separate photo markers. Telegram attaches the caption to only one message
// of the album, so `caption` is the single caption collected across the group.
export function buildAlbumMessage(items: AlbumItem[], caption?: string): string {
  const lines = [`[Album received: ${items.length} file(s).]`]
  items.forEach((it, i) => {
    const n = i + 1
    if (it.kind === 'document') {
      lines.push(`${n}. [Document: ${it.filename ?? 'file'}] File saved at: ${it.path}`)
    } else if (it.kind === 'video') {
      lines.push(`${n}. [Video] File saved at: ${it.path}`)
    } else {
      lines.push(`${n}. [Photo] File saved at: ${it.path}`)
    }
  })
  if (caption) lines.push(`Caption: ${caption}`)
  lines.push('Please analyze these files together as one album.')
  return lines.join('\n')
}

export function buildDocumentMessage(localPath: string, filename: string, caption?: string): string {
  const parts = [`[Document received: ${filename}. File saved at: ${localPath}]`]
  if (caption) parts.push(`Caption: ${caption}`)
  parts.push('Please read and process this document.')
  return parts.join('\n')
}

export function buildVideoMessage(localPath: string, caption?: string): string {
  const parts = [`[Video received. File saved at: ${localPath}]`]
  if (caption) parts.push(`Caption: ${caption}`)
  parts.push('Please analyze this video file.')
  return parts.join('\n')
}

/** The parts of an incoming Telegram message a follow-up is built from. */
export interface FollowupSource {
  text?: string
  caption?: string
  voice?: unknown
  photo?: { file_id: string }[]
  document?: { file_id: string; file_name?: string }
  video?: { file_id: string }
}

/**
 * Turn a message sent while the agent is busy into follow-up text.
 *
 * Media is downloaded whenever it is attached — the caption goes inside the
 * media message, never instead of it, so a captioned file is not lost.
 * Returns '' for a message with nothing to pass on.
 */
export async function buildFollowupText(
  m: FollowupSource,
  download: (fileId: string, filename?: string) => Promise<string>,
): Promise<string> {
  if (m.text) return m.text
  const photo = m.photo?.length ? m.photo[m.photo.length - 1] : undefined
  if (photo) {
    try {
      return buildPhotoMessage(await download(photo.file_id, 'photo.jpg'), m.caption)
    } catch (err) {
      logger.error({ err }, 'Follow-up photo download failed')
      return withCaption('[Photo received but download failed]', m.caption)
    }
  }
  if (m.document) {
    const name = m.document.file_name
    try {
      return buildDocumentMessage(await download(m.document.file_id, name), name ?? 'document', m.caption)
    } catch (err) {
      logger.error({ err }, 'Follow-up document download failed')
      return withCaption(`[Document: ${name ?? 'file'} - download failed]`, m.caption)
    }
  }
  if (m.video) {
    try {
      return buildVideoMessage(await download(m.video.file_id, 'video.mp4'), m.caption)
    } catch (err) {
      logger.error({ err }, 'Follow-up video download failed')
      return withCaption('[Video received but download failed]', m.caption)
    }
  }
  if (m.caption) return m.caption
  if (m.voice) return '[Voice message received]'
  return ''
}

function withCaption(marker: string, caption?: string): string {
  return caption ? `${marker}\nCaption: ${caption}` : marker
}

export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const files = readdirSync(UPLOADS_DIR)
    const now = Date.now()
    let cleaned = 0

    for (const file of files) {
      const filePath = join(UPLOADS_DIR, file)
      try {
        const stat = statSync(filePath)
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath)
          cleaned++
        }
      } catch { /* skip */ }
    }

    if (cleaned > 0) logger.info({ cleaned }, 'Old uploads cleaned')
  } catch { /* uploads dir may not exist yet */ }
}
