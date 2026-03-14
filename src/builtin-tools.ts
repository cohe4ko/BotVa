import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Context } from 'grammy'
import { InputFile } from 'grammy'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'
import { TELEGRAPH_ENABLED, PROJECT_ROOT } from './config.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

// --- Builtin tools config (enabled/disabled state) ---

const CONFIG_PATH = resolve(PROJECT_ROOT, 'workspace', 'builtin-tools.json')

export interface BuiltinToolDef {
  name: string
  icon: string
  category: string
  description: string
  condition?: string  // env var or feature required (for display)
  available: boolean  // whether requirements are met
  enabled: boolean    // user toggle
  system?: boolean    // true = standard Claude agent tool, can't be toggled
}

function readConfig(): Record<string, boolean> {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch { /* ignore */ }
  return {}
}

function writeConfig(config: Record<string, boolean>): void {
  mkdirSync(resolve(PROJECT_ROOT, 'workspace'), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

export function isToolEnabled(name: string): boolean {
  const config = readConfig()
  return config[name] !== false  // enabled by default
}

export function setToolEnabled(name: string, enabled: boolean): void {
  const config = readConfig()
  if (enabled) {
    delete config[name]  // default is enabled, so remove entry
  } else {
    config[name] = false
  }
  writeConfig(config)
}

/** Returns metadata for all builtin tools (for admin UI).
 *  Pass mergedEnv from all bots when calling from admin panel. */
export function getBuiltinToolDefs(mergedEnv?: Record<string, string>): BuiltinToolDef[] {
  const env = mergedEnv ?? readEnvFile()
  const hasGoogleApi = !!env['GOOGLE_API_KEY']
  const hasPublishSsh = !!env['PUBLISH_SSH_HOST']
  const config = readConfig()

  const hasGroq = !!env['GROQ_API_KEY']
  const hasSmtp = !!env['SMTP_HOST'] && !!env['SMTP_USER'] && !!env['SMTP_PASS']

  const defs: Omit<BuiltinToolDef, 'enabled'>[] = [
    // Standard Claude agent tools (always available, not toggleable)
    { name: 'Bash', icon: 'terminal', category: 'standard', description: 'Shell commands', available: true, system: true },
    { name: 'FileSystem', icon: 'folder', category: 'standard', description: 'Read, write, edit files', available: true, system: true },
    { name: 'WebSearch', icon: 'search', category: 'standard', description: 'Web search', available: true, system: true },
    { name: 'WebFetch', icon: 'globe', category: 'standard', description: 'Fetch web pages', available: true, system: true },
    { name: 'VoiceSTT', icon: 'mic', category: 'standard', description: 'Speech-to-text (Groq Whisper)', condition: 'GROQ_API_KEY', available: hasGroq, system: true },
    // Image
    { name: 'GenerateImage', icon: 'image', category: 'image', description: 'Generate image from prompt', condition: 'GOOGLE_API_KEY', available: hasGoogleApi },
    { name: 'EditImage', icon: 'pen-tool', category: 'image', description: 'Edit image with instruction', condition: 'GOOGLE_API_KEY', available: hasGoogleApi },
    // Voice
    { name: 'TextToSpeech', icon: 'volume-2', category: 'voice', description: 'Text to voice message (Edge-TTS)', available: true },
    // Publishing
    { name: 'PublishTelegraph', icon: 'newspaper', category: 'publish', description: 'Publish long text to Telegraph', condition: 'TELEGRAPH_ENABLED', available: TELEGRAPH_ENABLED },
    { name: 'ShareFile', icon: 'upload', category: 'publish', description: 'Upload file to public server', condition: 'PUBLISH_SSH_HOST', available: hasPublishSsh },
    // Gallery
    { name: 'ListGalleryImages', icon: 'grid', category: 'gallery', description: 'List gallery images with metadata', available: true },
    { name: 'SendGalleryImage', icon: 'send', category: 'gallery', description: 'Send gallery image to chat', available: true },
    { name: 'DeleteGalleryImage', icon: 'trash-2', category: 'gallery', description: 'Delete image from gallery', available: true },
    // Backup
    { name: 'CreateBackup', icon: 'save', category: 'backup', description: 'Create bot or system backup', available: true },
    { name: 'ListBackups', icon: 'list', category: 'backup', description: 'List available backups', available: true },
    { name: 'VerifyBackup', icon: 'check-circle', category: 'backup', description: 'Verify backup integrity', available: true },
    { name: 'RestoreBackup', icon: 'rotate-ccw', category: 'backup', description: 'Restore from backup', available: true },
    { name: 'DeleteBackup', icon: 'trash-2', category: 'backup', description: 'Delete backup file', available: true },
    // Memory
    { name: 'SaveFact', icon: 'bookmark', category: 'memory', description: 'Save a structured fact or event to permanent memory', available: true },
    { name: 'SearchMemory', icon: 'brain', category: 'memory', description: 'Search permanent memory by keywords and topic', available: true },
    { name: 'DeleteFact', icon: 'eraser', category: 'memory', description: 'Delete a fact by ID', available: true },
    // Email
    { name: 'SendEmail', icon: 'mail', category: 'communication', description: 'Send email via SMTP', condition: 'SMTP_HOST + SMTP_USER + SMTP_PASS', available: hasSmtp },
    // Telegram media
    { name: 'SendMedia', icon: 'send', category: 'telegram', description: 'Send photo/document/voice/video to chat', available: true },
    // Bot management
    { name: 'CreateBot', icon: 'plus-circle', category: 'management', description: 'Create a new bot', available: true },
    { name: 'DeleteBot', icon: 'trash-2', category: 'management', description: 'Delete a bot (with backup)', available: true },
    { name: 'ListBots', icon: 'users', category: 'management', description: 'List all bots and their status', available: true },
    // Currency
    { name: 'CurrencyRates', icon: 'banknote', category: 'finance', description: 'Cash exchange rates from Ukrainian exchangers', available: true },
    // Time
    { name: 'GetCurrentTime', icon: 'clock', category: 'utility', description: 'Current time in any timezone', available: true },
    // Reminders
    { name: 'CreateReminder', icon: 'bell', category: 'reminders', description: 'Set a one-shot reminder', available: true },
    { name: 'ListReminders', icon: 'bell-ring', category: 'reminders', description: 'List pending reminders', available: true },
    { name: 'DeleteReminder', icon: 'bell-off', category: 'reminders', description: 'Cancel a reminder', available: true },
  ]

  return defs.map(d => ({ ...d, enabled: config[d.name] !== false }))
}

export interface BuiltinToolsResult {
  server: McpSdkServerConfigWithInstance
  usedTools: Set<string>
}

export async function createBuiltinMcpServer(ctx: Context, chatId: number): Promise<BuiltinToolsResult | null> {
  const env = readEnvFile()
  const usedTools = new Set<string>()
  const tools: SdkMcpToolDefinition<any>[] = []
  const config = readConfig()

  const hasGoogleApi = !!env['GOOGLE_API_KEY']
  const hasPublishSsh = !!env['PUBLISH_SSH_HOST']

  // Helper: only register tool if enabled in config
  const isOn = (name: string) => config[name] !== false

  // --- Image generation tools (require GOOGLE_API_KEY) ---

  if (hasGoogleApi) {
    if (isOn('GenerateImage')) tools.push(
      tool(
        'GenerateImage',
        'Generate an image from a text prompt and send it to the chat. Use this when the user asks to create, draw, or generate an image.',
        { prompt: z.string().describe('Text prompt describing the image to generate') },
        async (args) => {
          usedTools.add('GenerateImage')
          try {
            await ctx.replyWithChatAction('upload_photo')
            const { generateImage } = await import('./imagen.js')
            const result = await generateImage(args.prompt)
            if (result.imagePath) {
              await ctx.replyWithPhoto(new InputFile(result.imagePath), {
                caption: result.text?.slice(0, 1024) ?? undefined,
              })
              return { content: [{ type: 'text' as const, text: `Image generated and sent to chat. ${result.text ?? ''}`.trim() }] }
            }
            return { content: [{ type: 'text' as const, text: result.text ?? 'Image generation returned no image' }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.error({ err }, 'GenerateImage tool failed')
            return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
          }
        }
      )
    )

    if (isOn('EditImage')) tools.push(
      tool(
        'EditImage',
        'Edit an existing image based on a text instruction and send the result to the chat. Use this when the user wants to modify, change, or edit an existing image.',
        {
          imagePath: z.string().describe('Absolute path to the image file to edit'),
          prompt: z.string().describe('Text instruction for how to edit the image'),
        },
        async (args) => {
          usedTools.add('EditImage')
          try {
            await ctx.replyWithChatAction('upload_photo')
            const { editImage } = await import('./imagen.js')
            const result = await editImage(args.imagePath, args.prompt)
            if (result.imagePath) {
              await ctx.replyWithPhoto(new InputFile(result.imagePath), {
                caption: result.text?.slice(0, 1024) ?? undefined,
              })
              return { content: [{ type: 'text' as const, text: `Image edited and sent to chat. ${result.text ?? ''}`.trim() }] }
            }
            return { content: [{ type: 'text' as const, text: result.text ?? 'Image editing returned no image' }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.error({ err }, 'EditImage tool failed')
            return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
          }
        }
      )
    )
  }

  // --- Voice (always available — edge-tts is free) ---

  if (isOn('TextToSpeech')) tools.push(
    tool(
      'TextToSpeech',
      'Convert text to speech and send as a voice message in the chat. Use this when the user asks to read text aloud or send a voice message.',
      { text: z.string().describe('Text to synthesize into speech') },
      async (args) => {
        usedTools.add('TextToSpeech')
        try {
          await ctx.replyWithChatAction('upload_voice')
          const { synthesizeSpeech } = await import('./voice.js')
          const audioPath = await synthesizeSpeech(args.text)
          await ctx.replyWithVoice(new InputFile(audioPath))
          return { content: [{ type: 'text' as const, text: 'Voice message sent' }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'TextToSpeech tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Telegraph (when enabled) ---

  if (TELEGRAPH_ENABLED && isOn('PublishTelegraph')) {
    tools.push(
      tool(
        'PublishTelegraph',
        'Publish a long text as a Telegraph page and return the URL. Use this for long-form content that would be too long for a chat message.',
        {
          title: z.string().describe('Title for the Telegraph page'),
          content: z.string().describe('Markdown content to publish'),
        },
        async (args) => {
          usedTools.add('PublishTelegraph')
          try {
            const { createTelegraphPage } = await import('./telegraph.js')
            const url = await createTelegraphPage(args.title, args.content)
            if (url) {
              return { content: [{ type: 'text' as const, text: `Published: ${url}` }] }
            }
            return { content: [{ type: 'text' as const, text: 'Failed to publish Telegraph page' }], isError: true }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.error({ err }, 'PublishTelegraph tool failed')
            return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
          }
        }
      )
    )
  }

  // --- ShareFile (when SSH publishing is configured) ---

  if (hasPublishSsh && isOn('ShareFile')) {
    tools.push(
      tool(
        'ShareFile',
        'Upload a file to the public server and return its URL. Use this to share files publicly.',
        {
          filePath: z.string().describe('Absolute path to the file to share'),
          subfolder: z.string().optional().describe('Optional subfolder on the server'),
        },
        async (args) => {
          usedTools.add('ShareFile')
          try {
            const { publishFile } = await import('./publish.js')
            const url = await publishFile(args.filePath, args.subfolder)
            if (url) {
              return { content: [{ type: 'text' as const, text: `File shared: ${url}` }] }
            }
            return { content: [{ type: 'text' as const, text: 'Failed to share file' }], isError: true }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.error({ err }, 'ShareFile tool failed')
            return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
          }
        }
      )
    )
  }

  // --- Gallery tools (always available) ---

  if (isOn('ListGalleryImages')) tools.push(
    tool(
      'ListGalleryImages',
      'List images in the gallery with metadata (id, bot, type, prompt, size, date). Results are sorted by date newest first — the FIRST item is the most recent. Supports pagination and optional bot name filter.',
      {
        limit: z.number().optional().describe('Max images to return (default 20)'),
        offset: z.number().optional().describe('Pagination offset (default 0)'),
        bot: z.string().optional().describe('Filter by bot name'),
      },
      async (args) => {
        usedTools.add('ListGalleryImages')
        try {
          const { getGalleryImages, countGalleryImages } = await import('./admin/db-multi.js')
          const { formatSize } = await import('./backup/index.js')
          const limit = args.limit ?? 20
          const images = getGalleryImages(limit, args.offset ?? 0, args.bot)
          const total = countGalleryImages(args.bot)
          if (images.length === 0) {
            return { content: [{ type: 'text' as const, text: `No images in gallery${args.bot ? ` for bot "${args.bot}"` : ''} (total: ${total})` }] }
          }
          const lines = images.map(img => {
            const date = new Date(img.created_at * 1000).toISOString().slice(0, 16)
            const promptShort = img.prompt.length > 80 ? img.prompt.slice(0, 80) + '...' : img.prompt
            return `#${img.id} | ${img.bot_name} | ${img.type} | ${formatSize(img.image_bytes)} | ${date} | ${promptShort}`
          })
          lines.unshift(`Gallery: ${total} images total, showing ${images.length} (sorted by date, newest first)`)
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'ListGalleryImages tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('SendGalleryImage')) tools.push(
    tool(
      'SendGalleryImage',
      'Send a gallery image to the chat by its ID. Sends the full-resolution image with prompt as caption.',
      { id: z.number().describe('Gallery image ID') },
      async (args) => {
        usedTools.add('SendGalleryImage')
        try {
          const { getGalleryImageById } = await import('./admin/db-multi.js')
          const { resolve } = await import('path')
          const image = getGalleryImageById(args.id)
          if (!image) {
            return { content: [{ type: 'text' as const, text: `Image #${args.id} not found in gallery` }], isError: true }
          }
          const { PROJECT_ROOT } = await import('./config.js')
          const imagePath = resolve(PROJECT_ROOT, 'workspace', 'gallery', image.filename)
          await ctx.replyWithChatAction('upload_photo')
          await ctx.replyWithPhoto(new InputFile(imagePath), {
            caption: image.prompt.slice(0, 1024),
          })
          return { content: [{ type: 'text' as const, text: `Sent gallery image #${args.id} (${image.type} by ${image.bot_name})` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SendGalleryImage tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('DeleteGalleryImage')) tools.push(
    tool(
      'DeleteGalleryImage',
      'Delete an image from the gallery by its ID. Removes the database entry and both the full image and thumbnail files.',
      { id: z.number().describe('Gallery image ID to delete') },
      async (args) => {
        usedTools.add('DeleteGalleryImage')
        try {
          const { deleteGalleryImage } = await import('./admin/db-multi.js')
          const { resolve } = await import('path')
          const { existsSync, unlinkSync } = await import('fs')
          const deleted = deleteGalleryImage(args.id)
          if (!deleted) {
            return { content: [{ type: 'text' as const, text: `Image #${args.id} not found in gallery` }], isError: true }
          }
          // Remove image files
          const { PROJECT_ROOT } = await import('./config.js')
          const galleryDir = resolve(PROJECT_ROOT, 'workspace', 'gallery')
          const imagePath = resolve(galleryDir, deleted.filename)
          const thumbName = deleted.filename.replace(/\.\w+$/, '.jpg')
          const thumbPath = resolve(galleryDir, 'thumbs', thumbName)
          if (existsSync(imagePath)) unlinkSync(imagePath)
          if (existsSync(thumbPath)) unlinkSync(thumbPath)
          return { content: [{ type: 'text' as const, text: `Deleted gallery image #${args.id}: "${deleted.prompt.slice(0, 100)}" (${deleted.filename})` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'DeleteGalleryImage tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Backup tools (always available) ---

  if (isOn('CreateBackup')) tools.push(
    tool(
      'CreateBackup',
      'Create a backup of a specific bot or the entire system. Returns backup filename and size. Use "bot" type with botName for a single bot, or "system" for full system backup including all bots, configs, and workspace.',
      {
        type: z.enum(['bot', 'system']).describe('Backup type: "bot" for single bot, "system" for everything'),
        botName: z.string().optional().describe('Bot name (required when type is "bot")'),
      },
      async (args) => {
        usedTools.add('CreateBackup')
        try {
          const { createBackup, formatSize } = await import('./backup/index.js')
          const info = createBackup({ type: args.type, botName: args.botName })
          return { content: [{ type: 'text' as const, text: `Backup created: ${info.filename} (${formatSize(info.sizeBytes)}), bots: ${info.manifest.bots.join(', ')}` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'CreateBackup tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('ListBackups')) tools.push(
    tool(
      'ListBackups',
      'List all available backups with their details (filename, type, bots, size, date).',
      {},
      async () => {
        usedTools.add('ListBackups')
        try {
          const { listBackups, formatSize } = await import('./backup/index.js')
          const backups = listBackups()
          if (backups.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No backups found' }] }
          }
          const lines = backups.map(b =>
            `${b.filename} | ${b.manifest.type} | bots: ${b.manifest.bots.join(', ')} | ${formatSize(b.sizeBytes)} | ${b.createdAt.toISOString()}`
          )
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'ListBackups tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('VerifyBackup')) tools.push(
    tool(
      'VerifyBackup',
      'Verify the integrity of a backup file. Checks archive structure and manifest validity.',
      { filename: z.string().describe('Backup filename (e.g. botva-system-2025-01-01T00-00-00.tar.gz)') },
      async (args) => {
        usedTools.add('VerifyBackup')
        try {
          const { verifyBackup, listBackups } = await import('./backup/index.js')
          const backups = listBackups()
          const backup = backups.find(b => b.filename === args.filename)
          if (!backup) {
            return { content: [{ type: 'text' as const, text: `Backup not found: ${args.filename}` }], isError: true }
          }
          const result = verifyBackup(backup.path)
          if (result.valid) {
            return { content: [{ type: 'text' as const, text: `Backup "${args.filename}" is valid` }] }
          }
          return { content: [{ type: 'text' as const, text: `Backup "${args.filename}" has errors: ${result.errors.join('; ')}` }], isError: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'VerifyBackup tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('RestoreBackup')) tools.push(
    tool(
      'RestoreBackup',
      'Restore a bot or system from a backup file. WARNING: this overwrites existing data. For bot backups you can optionally restore to a different bot name.',
      {
        filename: z.string().describe('Backup filename to restore from'),
        targetBotName: z.string().optional().describe('Override target bot name (for bot backups only)'),
      },
      async (args) => {
        usedTools.add('RestoreBackup')
        try {
          const { restoreBackup, listBackups } = await import('./backup/index.js')
          const backups = listBackups()
          const backup = backups.find(b => b.filename === args.filename)
          if (!backup) {
            return { content: [{ type: 'text' as const, text: `Backup not found: ${args.filename}` }], isError: true }
          }
          const result = await restoreBackup({
            archivePath: backup.path,
            targetBotName: args.targetBotName,
            overwrite: true,
          })
          const parts: string[] = [`Restored: ${result.restored.join(', ')}`]
          if (result.warnings.length > 0) {
            parts.push(`Warnings: ${result.warnings.join('; ')}`)
          }
          return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'RestoreBackup tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('DeleteBackup')) tools.push(
    tool(
      'DeleteBackup',
      'Delete a backup file. Only deletes files that match the backup naming convention.',
      { filename: z.string().describe('Backup filename to delete') },
      async (args) => {
        usedTools.add('DeleteBackup')
        try {
          const { deleteBackup } = await import('./backup/index.js')
          const deleted = deleteBackup(args.filename)
          if (deleted) {
            return { content: [{ type: 'text' as const, text: `Backup "${args.filename}" deleted` }] }
          }
          return { content: [{ type: 'text' as const, text: `Could not delete "${args.filename}" — not found or invalid filename` }], isError: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'DeleteBackup tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Facts (absolute long-term memory, no decay) ---

  const chatIdStr = String(chatId)

  if (isOn('SaveFact')) tools.push(
    tool(
      'SaveFact',
      'Save facts to your permanent long-term memory. Use PROACTIVELY whenever the user shares personal information, preferences, dates, decisions, or anything worth remembering. These facts NEVER decay. Supports batch — save multiple facts in one call. Each fact needs tags for search (synonyms, translations, related terms).',
      {
        facts: z.array(z.object({
          content: z.string().describe('Clean, concise statement. E.g.: "Birthday: March 5, 1990" or "Allergic to penicillin"'),
          topic: z.string().describe('Topic (lowercase): health, work, family, preferences, finance, travel, goals, projects, contacts, food, hobbies'),
          tags: z.string().describe('Comma-separated search tags: synonyms, translations, related terms. MORE is better. E.g. for allergy fact: "алергія, алергічний, allergy, penicillin, пеніцилін, антибіотик, ліки"'),
          sector: z.enum(['semantic', 'episodic']).describe('"semantic" = permanent fact. "episodic" = event/decision'),
        })).describe('Array of facts to save (batch)'),
      },
      async (args) => {
        usedTools.add('SaveFact')
        try {
          const { insertFactsBatch } = await import('./db.js')
          const ids = insertFactsBatch(chatIdStr, args.facts)
          // Fire-and-forget: generate embeddings for new facts
          Promise.all([import('./embeddings.js'), import('./db.js')]).then(([{ embedBatch }, { updateFactEmbedding }]) =>
            embedBatch(args.facts.map(f => f.content), 'passage').then(vecs => {
              for (let i = 0; i < ids.length; i++) {
                if (vecs[i]) updateFactEmbedding(ids[i], vecs[i]!)
              }
            })
          ).catch(err => logger.warn({ err }, 'Embedding generation failed'))
          const summary = args.facts.map((f, i) => `#${ids[i]} [${f.topic}]: ${f.content}`).join('\n')
          return { content: [{ type: 'text' as const, text: `Saved ${ids.length} facts:\n${summary}` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SaveFact tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('SearchMemory')) tools.push(
    tool(
      'SearchMemory',
      'Search your long-term memory for facts and events. Use when the user asks about something discussed before, or when you need to recall specific details. Search by keywords, filter by topic, or both.',
      {
        query: z.string().optional().describe('Keywords to search for (e.g. "birthday", "project deadline"). Omit to browse by topic only'),
        topic: z.string().optional().describe('Filter by topic (e.g. "health", "work"). Omit to search all topics'),
        limit: z.number().optional().describe('Max results (default 10)'),
      },
      async (args) => {
        usedTools.add('SearchMemory')
        try {
          const { getFactsByTopic } = await import('./db.js')
          const { searchFactsHybrid } = await import('./vector-search.js')
          const limit = args.limit ?? 10
          let results

          if (args.query) {
            results = await searchFactsHybrid(chatIdStr, args.query, limit, args.topic)
          } else if (args.topic) {
            results = getFactsByTopic(chatIdStr, args.topic, limit)
          } else {
            return { content: [{ type: 'text' as const, text: 'Provide query, topic, or both to search' }], isError: true }
          }

          if (!results || results.length === 0) {
            const ctx = [args.query && `"${args.query}"`, args.topic && `topic:${args.topic}`].filter(Boolean).join(', ')
            return { content: [{ type: 'text' as const, text: `No facts found for ${ctx}` }] }
          }

          const lines = results.map(f => {
            const date = new Date(f.created_at * 1000).toISOString().slice(0, 10)
            const sector = f.sector === 'semantic' ? 'fact' : 'event'
            return `#${f.id} [${f.topic}] [${date}] (${sector}) ${f.content}`
          })
          return { content: [{ type: 'text' as const, text: `Found ${results.length} facts:\n\n${lines.join('\n\n')}` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SearchMemory tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('DeleteFact')) tools.push(
    tool(
      'DeleteFact',
      'Delete a fact from long-term memory by ID. Use to remove outdated, incorrect, or duplicate facts.',
      {
        id: z.number().describe('Fact ID to delete (from SearchMemory results)'),
      },
      async (args) => {
        usedTools.add('DeleteFact')
        try {
          const { deleteFact } = await import('./db.js')
          const deleted = deleteFact(args.id, chatIdStr)
          if (deleted) {
            return { content: [{ type: 'text' as const, text: `Fact #${args.id} deleted` }] }
          }
          return { content: [{ type: 'text' as const, text: `Fact #${args.id} not found` }], isError: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'DeleteFact tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Email (SMTP) ---

  const hasSmtp = !!env['SMTP_HOST'] && !!env['SMTP_USER'] && !!env['SMTP_PASS']
  if (hasSmtp && isOn('SendEmail')) tools.push(
    tool(
      'SendEmail',
      'Send a beautifully formatted email via SMTP. Write the body in markdown — it will be automatically converted to a styled HTML email with proper typography. Use this when the user asks to send an email, notify someone by email, or forward information via email.',
      {
        to: z.string().describe('Recipient email address (or comma-separated for multiple)'),
        subject: z.string().describe('Email subject line'),
        body: z.string().describe('Email body in markdown format. Use headings, lists, bold, links etc. — they will be rendered as styled HTML'),
        cc: z.string().optional().describe('CC recipients (comma-separated)'),
        replyTo: z.string().optional().describe('Reply-To address'),
      },
      async (args) => {
        usedTools.add('SendEmail')
        try {
          const nodemailer = await import('nodemailer')
          const { markdownToEmailHtml } = await import('./email-template.js')
          const port = parseInt(env['SMTP_PORT'] || '587', 10)
          const transporter = nodemailer.createTransport({
            host: env['SMTP_HOST'],
            port,
            secure: port === 465,
            auth: { user: env['SMTP_USER'], pass: env['SMTP_PASS'] },
          })
          const from = env['SMTP_FROM'] || env['SMTP_USER']
          const signature = env['SMTP_SIGNATURE'] || undefined
          const html = markdownToEmailHtml(args.body, signature)
          const info = await transporter.sendMail({
            from,
            to: args.to,
            cc: args.cc,
            replyTo: args.replyTo,
            subject: args.subject,
            text: args.body,
            html,
          })
          return { content: [{ type: 'text' as const, text: `Email sent to ${args.to} (messageId: ${info.messageId})` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SendEmail tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Telegram media sending (always available) ---

  if (isOn('SendMedia')) tools.push(
    tool(
      'SendMedia',
      'Send a file to the chat as photo, document, voice, or video. Choose the appropriate type based on the file content.',
      {
        filePath: z.string().describe('Absolute path to the file to send'),
        type: z.enum(['photo', 'document', 'voice', 'video']).describe('Media type: photo, document, voice, or video'),
        caption: z.string().optional().describe('Optional caption (not supported for voice)'),
      },
      async (args) => {
        usedTools.add('SendMedia')
        try {
          const file = new InputFile(args.filePath)
          const caption = args.caption?.slice(0, 1024)
          switch (args.type) {
            case 'photo':
              await ctx.replyWithChatAction('upload_photo')
              await ctx.replyWithPhoto(file, { caption })
              break
            case 'document':
              await ctx.replyWithChatAction('upload_document')
              await ctx.replyWithDocument(file, { caption })
              break
            case 'voice':
              await ctx.replyWithChatAction('upload_voice')
              await ctx.replyWithVoice(file)
              break
            case 'video':
              await ctx.replyWithChatAction('upload_video')
              await ctx.replyWithVideo(file, { caption })
              break
          }
          return { content: [{ type: 'text' as const, text: `${args.type} sent` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SendMedia tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Currency rates (Ukrainian exchangers via Minfin/treeumapp) ---

  if (isOn('CurrencyRates')) tools.push(
    tool(
      'CurrencyRates',
      'Get current cash exchange rates from Ukrainian exchange offices (обмінники). Returns average buy/sell rates and number of exchangers reporting. Use when user asks about dollar/euro rate, "курс долара", "скільки коштує євро", etc.',
      {
        currencies: z.array(z.string()).optional().describe('Currency codes to fetch (default: ["usd", "eur"]). Available: usd, eur, pln, gbp, chf'),
        city: z.number().optional().describe('City ID (default: 3 = Lviv). 1 = Kyiv'),
      },
      async (args) => {
        usedTools.add('CurrencyRates')
        try {
          const currencies = args.currencies ?? ['usd', 'eur']
          const cityId = args.city ?? 3
          const cityNames: Record<number, string> = { 1: 'Київ', 3: 'Львів' }
          const cityName = cityNames[cityId] ?? `city ${cityId}`

          // Fetch exchanger rates + PrivatBank in parallel
          const [exchangerResults, privatResult] = await Promise.all([
            Promise.all(
              currencies.map(async (ccy) => {
                const url = `https://va-rates.treeumapp.net/api/v1/rates?currency=${ccy}&kind=exchanger&city=${cityId}&group=day`
                const resp = await fetch(url, {
                  headers: {
                    'origin': 'https://minfin.com.ua',
                    'referer': 'https://minfin.com.ua/',
                  },
                })
                if (!resp.ok) return `${ccy.toUpperCase()}: unavailable`
                const data = await resp.json() as { items: Record<string, Array<{ buy: number; sell: number; buy_n: number; sell_n: number }>> }
                const items = Object.values(data.items)[0]
                if (!items || items.length === 0) return `${ccy.toUpperCase()}: no data`
                const last = items[items.length - 1]
                return `${ccy.toUpperCase()}: купівля ${last.buy.toFixed(2)} / продаж ${last.sell.toFixed(2)} (${last.buy_n.toFixed(0)} обмінників)`
              })
            ),
            fetch('https://api.privatbank.ua/p24api/pubinfo?exchange&coursid=5')
              .then(r => r.json())
              .then((data: Array<{ ccy: string; buy: string; sale: string }>) => {
                const filtered = data.filter(d => currencies.includes(d.ccy.toLowerCase()))
                return filtered.map(d => `${d.ccy}: купівля ${parseFloat(d.buy).toFixed(2)} / продаж ${parseFloat(d.sale).toFixed(2)}`)
              })
              .catch(() => [] as string[]),
          ])

          const lines = [`Обмінники (${cityName}):`, ...exchangerResults]
          if (privatResult.length > 0) {
            lines.push('', 'ПриватБанк (готівка):', ...privatResult)
          }

          return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'CurrencyRates tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Current time ---

  if (isOn('GetCurrentTime')) tools.push(
    tool(
      'GetCurrentTime',
      'Get current date and time in any timezone. Use when the user asks "what time is it", "котра година", "який зараз час", or needs current time for scheduling.',
      {
        timezone: z.string().optional().describe('IANA timezone (default: "Europe/Kyiv"). Examples: "America/New_York", "Asia/Tokyo", "UTC"'),
      },
      async (args) => {
        usedTools.add('GetCurrentTime')
        const tz = args.timezone ?? 'Europe/Kyiv'
        try {
          const now = new Date()
          const formatted = now.toLocaleString('uk-UA', {
            timeZone: tz,
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
          const iso = now.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')
          return { content: [{ type: 'text' as const, text: `${formatted} (${tz})\nISO: ${iso}` }] }
        } catch {
          return { content: [{ type: 'text' as const, text: `Invalid timezone: "${tz}"` }], isError: true }
        }
      }
    )
  )

  // --- Bot management tools ---

  if (isOn('ListBots')) tools.push(
    tool(
      'ListBots',
      'List all bots in the system with their running status and uptime. Use to see what bots exist before creating or deleting.',
      {},
      async () => {
        usedTools.add('ListBots')
        try {
          const { listBots } = await import('./bot-manager.js')
          const bots = listBots()
          if (bots.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No bots found' }] }
          }
          const lines = bots.map(b => {
            const status = b.running ? `running (pid ${b.pid}, uptime ${b.uptime})` : 'stopped'
            return `${b.name}: ${status}`
          })
          return { content: [{ type: 'text' as const, text: `${bots.length} bots:\n${lines.join('\n')}` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('CreateBot')) {
    // Build dynamic role list for description
    let roleList = ''
    try {
      const { getAvailableRoles } = await import('./bot-manager.js')
      const roles = getAvailableRoles()
      if (roles.length > 0) roleList = ` Available roles: ${roles.map(r => r.slug).join(', ')}.`
    } catch { /* ignore */ }

    tools.push(
      tool(
        'CreateBot',
        `Create a new Telegram bot. Requires name (lowercase slug) and token from @BotFather.${roleList}`,
        {
          name: z.string().describe('Bot slug (lowercase, e.g. "sales-bot")'),
          token: z.string().describe('Telegram bot token from @BotFather'),
          role: z.string().optional().describe('Role template slug (e.g. "personal-assistant", "researcher")'),
          displayName: z.string().optional().describe('Display name for the bot'),
          emoji: z.string().optional().describe('Bot emoji (default 🤖)'),
          chatId: z.string().optional().describe('Allowed Telegram chat ID'),
          personality: z.string().optional().describe('Personality description (only used when no role template)'),
          autoStart: z.boolean().optional().describe('Start bot after creation (default false)'),
        },
        async (args) => {
          usedTools.add('CreateBot')
          try {
            const { createBot } = await import('./bot-manager.js')
            const result = createBot({
              name: args.name,
              token: args.token,
              role: args.role,
              displayName: args.displayName,
              emoji: args.emoji,
              chatId: args.chatId,
              personality: args.personality,
            })
            let msg = `Bot "${result.name}" created`
            if (result.role) msg += ` with role "${result.role}"`
            if (args.autoStart) {
              const { startBot } = await import('./admin/bot-control.js')
              startBot(result.name)
              msg += '. Bot started.'
            }
            return { content: [{ type: 'text' as const, text: msg }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.error({ err }, 'CreateBot tool failed')
            return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
          }
        }
      )
    )
  }

  if (isOn('DeleteBot')) tools.push(
    tool(
      'DeleteBot',
      'Delete a bot by name. Creates a backup first, then removes the bot directory and team.json entry. Cannot delete self.',
      {
        name: z.string().describe('Bot slug to delete'),
      },
      async (args) => {
        usedTools.add('DeleteBot')
        try {
          const { BOT_NAME } = await import('./env.js')
          if (args.name === BOT_NAME) {
            return { content: [{ type: 'text' as const, text: 'Cannot delete self' }], isError: true }
          }
          const { deleteBot } = await import('./bot-manager.js')
          const result = await deleteBot(args.name)
          return { content: [{ type: 'text' as const, text: `Bot "${result.name}" deleted. Backup: ${result.backupFilename}` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'DeleteBot tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Reminder tools ---

  if (isOn('CreateReminder')) tools.push(
    tool(
      'CreateReminder',
      'Set a one-shot reminder. The bot will send a message to the chat at the specified time. Use for "remind me at...", "нагадай о...", "через 2 години..." requests.',
      {
        text: z.string().describe('Reminder text (what to remind about)'),
        remindAt: z.string().describe('When to remind, ISO 8601 datetime (e.g. "2025-03-15T15:00:00")'),
      },
      async (args) => {
        usedTools.add('CreateReminder')
        try {
          const { insertReminder } = await import('./db.js')
          const remindAtTs = Math.floor(new Date(args.remindAt).getTime() / 1000)
          if (isNaN(remindAtTs) || remindAtTs <= 0) {
            return { content: [{ type: 'text' as const, text: `Invalid date: ${args.remindAt}` }], isError: true }
          }
          const now = Math.floor(Date.now() / 1000)
          if (remindAtTs <= now) {
            return { content: [{ type: 'text' as const, text: 'Reminder time must be in the future' }], isError: true }
          }
          const id = insertReminder(chatIdStr, args.text, remindAtTs)
          const dateStr = new Date(remindAtTs * 1000).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
          return { content: [{ type: 'text' as const, text: `Reminder #${id} set for ${dateStr}: "${args.text}"` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'CreateReminder tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('ListReminders')) tools.push(
    tool(
      'ListReminders',
      'List all pending reminders for the current chat.',
      {},
      async () => {
        usedTools.add('ListReminders')
        try {
          const { listReminders } = await import('./db.js')
          const reminders = listReminders(chatIdStr)
          if (reminders.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No pending reminders' }] }
          }
          const lines = reminders.map(r => {
            const date = new Date(r.remind_at * 1000).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
            return `#${r.id} | ${date} | ${r.text}`
          })
          return { content: [{ type: 'text' as const, text: `${reminders.length} pending reminders:\n${lines.join('\n')}` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (isOn('DeleteReminder')) tools.push(
    tool(
      'DeleteReminder',
      'Cancel a pending reminder by its ID.',
      {
        id: z.number().describe('Reminder ID to cancel (from ListReminders)'),
      },
      async (args) => {
        usedTools.add('DeleteReminder')
        try {
          const { deleteReminder } = await import('./db.js')
          const deleted = deleteReminder(args.id, chatIdStr)
          if (deleted) {
            return { content: [{ type: 'text' as const, text: `Reminder #${args.id} cancelled` }] }
          }
          return { content: [{ type: 'text' as const, text: `Reminder #${args.id} not found` }], isError: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  if (tools.length === 0) return null

  const server = createSdkMcpServer({
    name: 'builtin',
    version: '1.0.0',
    tools,
  })

  logger.debug({ toolCount: tools.length, tools: tools.map(t => t.name) }, 'Builtin MCP server created')

  return { server, usedTools }
}
