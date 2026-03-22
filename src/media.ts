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
