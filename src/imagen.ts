import { GoogleGenAI } from '@google/genai'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join, resolve, basename } from 'path'
import sharp from 'sharp'
import { UPLOADS_DIR } from './media.js'
import { readEnvFile, BOT_NAME } from './env.js'
import { logger } from './logger.js'
import { logImagenUsage } from './db.js'
import { PROJECT_ROOT } from './config.js'
import { addGalleryImage } from './admin/db-multi.js'

const GALLERY_DIR = resolve(PROJECT_ROOT, 'workspace', 'gallery')
const THUMBS_DIR = resolve(GALLERY_DIR, 'thumbs')

const MODEL = readEnvFile()['IMAGEN_MODEL'] ?? 'gemini-3.1-flash-image-preview'

function getClient(): GoogleGenAI {
  const env = readEnvFile()
  const apiKey = env['GOOGLE_API_KEY']
  if (!apiKey) throw new Error('GOOGLE_API_KEY не встановлений в .env')
  return new GoogleGenAI({ apiKey })
}

export interface ImageResult {
  imagePath: string | null
  text: string | null
  imageBytes: number
}

/**
 * Generate an image from a text prompt
 */
export async function generateImage(prompt: string): Promise<ImageResult> {
  const ai = getClient()

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  })

  const result = extractResult(response)
  trackUsage('generate', prompt, response, result)
  saveToGallery('generate', prompt, result)
  return result
}

/**
 * Edit an image: send image + text instruction
 */
export async function editImage(imagePath: string, prompt: string): Promise<ImageResult> {
  const ai = getClient()
  const imageData = readFileSync(imagePath)
  const base64Image = imageData.toString('base64')

  const ext = imagePath.toLowerCase()
  let mimeType = 'image/png'
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) mimeType = 'image/jpeg'
  else if (ext.endsWith('.webp')) mimeType = 'image/webp'

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: base64Image,
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  })

  const result = extractResult(response)
  trackUsage('edit', prompt, response, result)
  saveToGallery('edit', prompt, result)
  return result
}

function extractResult(response: any): ImageResult {
  let text: string | null = null
  let imagePath: string | null = null
  let imageBytes = 0

  const parts = response?.candidates?.[0]?.content?.parts ?? []

  for (const part of parts) {
    if (part.text) {
      text = (text ?? '') + part.text
    }
    if (part.inlineData) {
      const buffer = Buffer.from(part.inlineData.data, 'base64')
      const ext = part.inlineData.mimeType?.includes('png') ? 'png' : 'jpg'
      imagePath = join(UPLOADS_DIR, `img_${Date.now()}.${ext}`)
      writeFileSync(imagePath, buffer)
      imageBytes = buffer.length
      logger.info({ imagePath, size: buffer.length }, 'Image generated')
    }
  }

  return { imagePath, text, imageBytes }
}

function trackUsage(type: 'generate' | 'edit', prompt: string, response: any, result: ImageResult): void {
  try {
    const usage = response?.usageMetadata ?? {}
    const inputTokens = usage.promptTokenCount ?? 0
    const outputTokens = usage.candidatesTokenCount ?? usage.totalTokenCount ?? 0
    logImagenUsage(type, prompt, MODEL, inputTokens, outputTokens, result.imageBytes)
    logger.info({ type, inputTokens, outputTokens, imageBytes: result.imageBytes }, 'Imagen usage logged')
  } catch (err) {
    logger.warn({ err }, 'Failed to log imagen usage')
  }
}

async function saveToGallery(type: 'generate' | 'edit', prompt: string, result: ImageResult): Promise<void> {
  if (!result.imagePath) return
  try {
    mkdirSync(GALLERY_DIR, { recursive: true })
    mkdirSync(THUMBS_DIR, { recursive: true })
    const fname = basename(result.imagePath)
    const dest = join(GALLERY_DIR, fname)
    copyFileSync(result.imagePath, dest)

    // Generate thumbnail (400px wide, JPEG for smaller size)
    const thumbName = fname.replace(/\.\w+$/, '.jpg')
    const thumbPath = join(THUMBS_DIR, thumbName)
    await sharp(dest)
      .resize(400, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbPath)

    addGalleryImage(BOT_NAME, type, prompt, fname, result.imageBytes)
    logger.info({ filename: fname }, 'Image saved to gallery')
  } catch (err) {
    logger.warn({ err }, 'Failed to save to gallery')
  }
}
