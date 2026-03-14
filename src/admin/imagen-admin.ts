import { GoogleGenAI } from '@google/genai'
import { writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp from 'sharp'
import { getProjectRoot, getBotNames, addGalleryImage } from './db-multi.js'
import { readEnv } from './env-parser.js'

const GALLERY_DIR = resolve(getProjectRoot(), 'workspace', 'gallery')
const THUMBS_DIR = resolve(GALLERY_DIR, 'thumbs')

function getMergedEnv(): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const bot of getBotNames()) {
    const env = readEnv(bot)
    for (const [k, v] of Object.entries(env)) {
      if (v && !merged[k]) merged[k] = v
    }
  }
  return merged
}

function getApiKey(): string {
  const env = getMergedEnv()
  const key = env['GOOGLE_API_KEY']
  if (!key) throw new Error('GOOGLE_API_KEY not found in any bot .env')
  return key
}

function getModel(): string {
  const env = getMergedEnv()
  return env['IMAGEN_MODEL'] ?? 'gemini-3.1-flash-image-preview'
}

export interface AdminImageResult {
  filename: string
  text: string | null
}

export async function adminGenerateImage(prompt: string, referenceImages?: Buffer[]): Promise<AdminImageResult> {
  const ai = new GoogleGenAI({ apiKey: getApiKey() })
  const model = getModel()

  const parts: any[] = [{ text: prompt }]
  if (referenceImages?.length) {
    for (const buf of referenceImages) {
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: buf.toString('base64'),
        },
      })
    }
  }

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  })

  return saveResult(response, 'generate', prompt)
}

export async function adminEditImage(existingImageBuf: Buffer, prompt: string, extraImages?: Buffer[]): Promise<AdminImageResult> {
  const ai = new GoogleGenAI({ apiKey: getApiKey() })
  const model = getModel()

  const parts: any[] = [
    { text: prompt },
    { inlineData: { mimeType: 'image/png', data: existingImageBuf.toString('base64') } },
  ]
  if (extraImages?.length) {
    for (const buf of extraImages) {
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: buf.toString('base64'),
        },
      })
    }
  }

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  })

  return saveResult(response, 'edit', prompt)
}

async function saveResult(response: any, type: 'generate' | 'edit', prompt: string): Promise<AdminImageResult> {
  let text: string | null = null
  let imageBuffer: Buffer | null = null

  const parts = response?.candidates?.[0]?.content?.parts ?? []
  for (const part of parts) {
    if (part.text) text = (text ?? '') + part.text
    if (part.inlineData) {
      imageBuffer = Buffer.from(part.inlineData.data, 'base64')
    }
  }

  if (!imageBuffer) throw new Error('No image in response')

  mkdirSync(GALLERY_DIR, { recursive: true })
  mkdirSync(THUMBS_DIR, { recursive: true })

  const filename = `img_${Date.now()}.png`
  const dest = join(GALLERY_DIR, filename)
  writeFileSync(dest, imageBuffer)

  // Generate thumbnail
  const thumbName = filename.replace(/\.\w+$/, '.jpg')
  const thumbPath = join(THUMBS_DIR, thumbName)
  await sharp(dest)
    .resize(400, null, { withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(thumbPath)

  addGalleryImage('admin', type, prompt, filename, imageBuffer.length)

  return { filename, text }
}
