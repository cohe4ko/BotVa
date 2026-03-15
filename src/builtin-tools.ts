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
    // User interaction
    { name: 'AskUser', icon: 'message-circle', category: 'telegram', description: 'Ask user to choose from options via buttons', available: true },
    // Bot management
    { name: 'CreateBot', icon: 'plus-circle', category: 'management', description: 'Create a new bot', available: true },
    { name: 'DeleteBot', icon: 'trash-2', category: 'management', description: 'Delete a bot (with backup)', available: true },
    { name: 'ListBots', icon: 'users', category: 'management', description: 'List all bots and their status', available: true },
    // Currency
    { name: 'CurrencyRates', icon: 'banknote', category: 'finance', description: 'Cash exchange rates from Ukrainian exchangers', available: true },
    // Time
    { name: 'GetCurrentTime', icon: 'clock', category: 'utility', description: 'Current time in any timezone', available: true },
    // Code
    { name: 'RunPython', icon: 'code', category: 'code', description: 'Execute Python code (calculations, data, charts)', available: true },
    // Reminders
    { name: 'CreateReminder', icon: 'bell', category: 'reminders', description: 'Set a one-shot reminder', available: true },
    { name: 'ListReminders', icon: 'bell-ring', category: 'reminders', description: 'List pending reminders', available: true },
    { name: 'DeleteReminder', icon: 'bell-off', category: 'reminders', description: 'Cancel a reminder', available: true },
    // Screenshot
    { name: 'TakeScreenshot', icon: 'camera', category: 'browser', description: 'Screenshot a webpage or system screen', available: true },
    // Session
    { name: 'NameSession', icon: 'tag', category: 'utility', description: 'Name the current session', available: true },
  ]

  return defs.map(d => ({ ...d, enabled: config[d.name] !== false }))
}

export type AskUserCallback = (
  question: string,
  options: { label: string; description?: string }[],
  keyboard: 'inline' | 'reply',
  text?: string,
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown'
) => Promise<string>

export interface BuiltinToolsResult {
  server: McpSdkServerConfigWithInstance
  usedTools: Set<string>
  cleanup?: () => void
}

export async function createBuiltinMcpServer(ctx: Context, chatId: number, askUser?: AskUserCallback): Promise<BuiltinToolsResult | null> {
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
        'Edit an existing image based on a text instruction and send the result to the chat. Use when user says "зміни фон", "прибери текст", "додай рамку", "зроби яскравіше" or wants to modify an existing photo/image. NOT for creating new images from scratch — use GenerateImage for that.',
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
      'Convert text to speech and send as a voice message. Use when user says "озвуч", "прочитай вголос", "надішли голосовим", "зроби аудіо", or when a voice response would be more convenient (e.g. long text user will listen to while driving). NOT for transcribing voice — that is VoiceSTT (automatic).',
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
        'Publish text as a Telegraph page and return a shareable URL. Use PROACTIVELY when your response is longer than ~2000 chars — publish the full version to Telegraph and send the link with a short summary. Also use when user asks "зроби статтю", "опублікуй", or wants a clean readable page. Accepts markdown. NOT for short answers that fit in a chat message.',
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
      'Send a previously generated image from gallery to the chat. Use when user says "покажи ту картинку", "надішли фото що ти робив", or wants to see a past generation. First call ListGalleryImages to find the ID, then SendGalleryImage.',
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
      'Delete an image from gallery by ID. Use when user says "видали цю картинку", "прибери з галереї". First ListGalleryImages to find the ID.',
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
      'Create a backup of a bot or the entire system. Use when user says "зроби бекап", "збережи стан", or BEFORE risky operations (deleting bot, major config changes). Type "bot" + botName for a single bot, "system" for everything.',
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

  if (isOn('SaveFact')) tools.push(makeSaveFactTool(chatIdStr, usedTools))
  if (isOn('SearchMemory')) tools.push(makeSearchMemoryTool(chatIdStr, usedTools))
  if (isOn('DeleteFact')) tools.push(makeDeleteFactTool(chatIdStr, usedTools))

  // --- Email (SMTP) ---

  const hasSmtp = !!env['SMTP_HOST'] && !!env['SMTP_USER'] && !!env['SMTP_PASS']
  if (hasSmtp && isOn('SendEmail')) tools.push(
    tool(
      'SendEmail',
      'Send a styled HTML email via SMTP. Body in markdown — auto-converted to beautiful HTML. Use when user says "надішли email", "напиши листа", "відправ на пошту", or wants to share results/reports/summaries by email. Also use proactively when a task result would be useful to send (e.g. research summary, report). NOT for Telegram messages — those go through regular chat.',
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
      'Send a file to the chat as photo, document, voice, or video. Use AFTER creating/downloading/finding a file that the user needs — e.g. after RunPython generates a chart, after downloading a document, after writing a file user asked for. Also use when user says "надішли", "покажи фото", "відправ файл". Choose type: photo for images, document for PDF/CSV/etc, voice for audio, video for video.',
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
      'Get current cash exchange rates from Ukrainian exchangers. Use when user asks "курс долара", "скільки коштує євро", "курс валют", or needs to convert UAH/USD/EUR. Also use PROACTIVELY when discussing prices in foreign currency — show the equivalent. Available: usd, eur, pln, gbp, chf. NOT for crypto or historical rates — use WebSearch for those.',
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
      'Get current date and time. Use when user asks "котра година", "який сьогодні день", "яке число". Also use BEFORE CreateReminder to calculate the right datetime. Use when you need to know current date for any reason (age calculation, days until event, etc.).',
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
      'Set a one-shot reminder — bot will message the chat at the specified time. Use when user says "нагадай", "remind me", "через годину", "завтра о 9", "не забути". Also use PROACTIVELY when user mentions a deadline or event they should remember. Use GetCurrentTime first to calculate the correct ISO datetime. NOT for recurring events — use Google Calendar for those.',
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

  // --- Python sandbox ---

  let sandbox: import('./python-sandbox.js').PythonSandbox | null = null

  if (isOn('RunPython')) tools.push(
    tool(
      'RunPython',
      `Execute Python code in a persistent sandbox. Use when user asks to calculate, analyze data, or build a chart. Triggers: "порахуй", "побудуй графік", "проаналізуй дані", "скільки буде", any math/statistics task.

Available: pandas, numpy, matplotlib, sympy. Charts auto-sent to chat (use plt.savefig). Variables persist between calls.

Use RunPython instead of manual calculation when: percentages, currency conversion, date math, statistics, or anything with >2 numbers. NOT for simple single-number answers you can compute in your head.`,
      { code: z.string().describe('Python code to execute') },
      async (args) => {
        usedTools.add('RunPython')
        try {
          if (!sandbox) {
            const { PythonSandbox } = await import('./python-sandbox.js')
            const { BOT_DIR } = await import('./env.js')
            const sandboxDir = resolve(BOT_DIR, 'workspace', 'sandbox')
            sandbox = new PythonSandbox(sandboxDir)
          }
          const result = await sandbox.execute(args.code)

          // Send generated files to chat
          for (const filePath of result.files) {
            try {
              if (/\.(png|jpg|jpeg|gif|webp)$/i.test(filePath)) {
                await ctx.replyWithPhoto(new InputFile(filePath))
              } else {
                await ctx.replyWithDocument(new InputFile(filePath))
              }
            } catch (sendErr) {
              logger.error({ err: sendErr, filePath }, 'Failed to send sandbox file')
            }
          }

          const parts: string[] = []
          if (result.stdout) parts.push(result.stdout)
          if (result.stderr) parts.push(`stderr: ${result.stderr}`)
          if (result.error) parts.push(`Error:\n${result.error}`)
          if (result.files.length > 0) parts.push(`Files sent: ${result.files.map(f => f.split('/').pop()).join(', ')}`)
          const text = parts.join('\n') || 'Code executed successfully (no output)'

          return { content: [{ type: 'text' as const, text }], isError: !!result.error }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'RunPython tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- AskUser tool (present choices to user via Telegram buttons) ---

  if (askUser && isOn('AskUser')) tools.push(
    tool(
      'AskUser',
      `Present choices to the user via Telegram buttons and wait for their response.

IMPORTANT: AskUser is a STEP within your workflow, not an interruption. Call it mid-task when you need user input, get the answer, and continue working. Do NOT stop or summarize — just ask and proceed with the chosen option.

WHEN TO USE:
- The user's request can be fulfilled in several different ways and you need them to choose
- Before an irreversible external action (email, CRM, posting) when details are ambiguous
- Search returned multiple results and user should pick one
- Yes/no confirmation before a risky or costly action

WHEN NOT TO USE:
- The choice is obvious from context or user already specified what they want
- You need free-form input (name, description, long text) — just ask in text
- Only one valid option exists
- User said "just do it" or similar

KEYBOARD MODES:
- 'inline' (default): buttons under message. Short labels only (1-4 words, max ~20 chars). Buttons disappear after click. Has "Other" option automatically.
- 'reply': buttons replace the keyboard. Supports longer labels (full sentences OK). Answer appears as text in chat. Best for: yes/no, confirmations, options with long descriptions. No "Other" option.

Use 'reply' when:
- Yes/no or confirmation (Так/Ні)
- Labels are longer than 4 words
- You want the answer visible in chat history

Use 'inline' when:
- Short labels (1-4 words)
- Multiple options (4+)
- You want "Other" as fallback

EXAMPLES:
- "Знайди рецепт борщу" (3 results) → AskUser: "Який?", options=["Класичний", "Полтавський", "Вегетаріанський"], keyboard='inline'
- "Видали файл" → AskUser: "Точно видалити?", options=["Так, видалити", "Ні, залишити"], keyboard='reply'
- "Надішли email" → AskUser: "Надіслати цей лист Олені?", options=["Так, надіслати", "Ні, ще відредагую"], keyboard='reply'
- Complex choice → AskUser: "Який формат?", options=["Детальний звіт з графіками", "Коротке резюме на 1 сторінку", "Таблиця з даними"], keyboard='reply'

2-8 options. Tool blocks until user responds (2 min timeout).`,
      {
        question: z.string().describe('The question to ask the user'),
        options: z.array(z.object({
          label: z.string().describe('Button label'),
          description: z.string().optional().describe('Brief explanation shown under the question'),
        })).min(2).max(8).describe('Available choices (2-8 options)'),
        keyboard: z.enum(['inline', 'reply']).default('inline').describe(
          'inline = buttons under message (short labels, has "Other"), reply = buttons replace keyboard (long labels OK, answer as text in chat)'
        ),
        text: z.string().optional().describe(
          'Custom message text. If provided, replaces the auto-generated message above the buttons.'
        ),
        parse_mode: z.enum(['HTML', 'MarkdownV2', 'Markdown']).optional().describe(
          'Telegram parse mode for the text. Default: HTML for auto-generated, none for custom text. Use MarkdownV2 for bold/italic/code in custom text.'
        ),
      },
      async ({ question, options, keyboard, text, parse_mode: pm }) => {
        usedTools.add('AskUser')
        try {
          const answer = await askUser(question, options, keyboard, text, pm)
          if (answer === '__skip__') {
            return { content: [{ type: 'text' as const, text: 'User wants a different option (clicked "Other"). Ask them in text what they prefer.' }] }
          }
          return { content: [{ type: 'text' as const, text: `User chose: ${answer}` }] }
        } catch {
          return { content: [{ type: 'text' as const, text: 'User did not respond (timeout).' }], isError: true }
        }
      }
    )
  )

  // --- Screenshot tool ---

  if (isOn('TakeScreenshot')) tools.push(
    tool(
      'TakeScreenshot',
      `Take a screenshot of a webpage or system screen. Returns the image to you (you can see and analyze it) AND sends it to the chat.

Use PROACTIVELY:
- To verify how a page looks after deploy or changes
- To see what's on a webpage before extracting data
- To check the current state of the system screen
- When user asks "покажи сайт", "як виглядає", "зроби скріншот"

type 'web': opens URL in headless Chromium, takes screenshot. Use fullPage=true for long pages.
type 'system': captures the current system screen (macOS).`,
      {
        type: z.enum(['web', 'system']).default('web').describe('web = webpage screenshot, system = desktop capture'),
        url: z.string().optional().describe('URL to screenshot (required for web)'),
        fullPage: z.boolean().default(false).describe('Capture full scrollable page (web only)'),
      },
      async ({ type, url, fullPage }) => {
        usedTools.add('TakeScreenshot')
        try {
          if (type === 'web' && !url) {
            return { content: [{ type: 'text' as const, text: 'Error: url is required for web screenshots' }], isError: true }
          }

          await ctx.replyWithChatAction('upload_photo')
          const { execSync } = await import('child_process')
          const { unlinkSync } = await import('fs')
          const ts = Date.now()
          const rawPath = `/tmp/ss-${ts}.png`

          if (type === 'web') {
            const args = ['npx', 'playwright', 'screenshot', url!, rawPath]
            if (fullPage) args.push('--full-page')
            execSync(args.join(' '), { timeout: 30000, stdio: 'pipe' })
          } else {
            execSync(`screencapture -x ${rawPath}`, { timeout: 5000, stdio: 'pipe' })
          }

          // Optimize with sharp
          const sharp = (await import('sharp')).default
          const optPath = `/tmp/ss-opt-${ts}.png`
          await sharp(rawPath).resize(1280, null, { withoutEnlargement: true }).png().toFile(optPath)

          // Read as base64 for model
          const imageData = readFileSync(optPath).toString('base64')

          // Send to chat
          const caption = type === 'web' ? url! : 'System screenshot'
          await ctx.replyWithPhoto(new InputFile(optPath), { caption })

          // Cleanup
          try { unlinkSync(rawPath) } catch { /* ignore */ }
          try { unlinkSync(optPath) } catch { /* ignore */ }

          // Return image to model
          return {
            content: [
              { type: 'image' as const, data: imageData, mimeType: 'image/png' },
              { type: 'text' as const, text: `Screenshot: ${caption}` },
            ]
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'TakeScreenshot failed')
          return { content: [{ type: 'text' as const, text: `Screenshot error: ${msg}` }], isError: true }
        }
      }
    )
  )

  // --- Session naming ---

  if (isOn('NameSession')) tools.push(makeNameSessionTool(chatIdStr, usedTools))

  if (tools.length === 0) return null

  const server = createSdkMcpServer({
    name: 'builtin',
    version: '1.0.0',
    tools,
  })

  const cleanup = () => {
    sandbox?.kill()
    sandbox = null
  }

  logger.debug({ toolCount: tools.length, tools: tools.map(t => t.name) }, 'Builtin MCP server created')

  return { server, usedTools, cleanup }
}

// --- Memory tool factories (shared between builtin and consolidation servers) ---

function makeSaveFactTool(chatIdStr: string, usedTools: Set<string>): SdkMcpToolDefinition<any> {
  return tool(
    'SaveFact',
    'Save facts to PERMANENT memory (never decays). ALWAYS SearchMemory first to avoid duplicates — if fact exists and changed, DeleteFact old + SaveFact new. Use PROACTIVELY when user shares: dates, names, preferences, health info, decisions, contacts. Also save important results from tool calls (WebSearch, CRM, stagehand) if they answer a specific question and will be useful in future conversations. Batch supported. Tags must include synonyms and translations for better search.',
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
}

function makeSearchMemoryTool(chatIdStr: string, usedTools: Set<string>): SdkMcpToolDefinition<any> {
  return tool(
    'SearchMemory',
    'Search permanent memory (facts & events). Use: (1) BEFORE SaveFact to check for duplicates, (2) when user asks about past conversations/people/projects/preferences, (3) when you need context before answering. Supports semantic search — natural language queries work well.',
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
          const searchCtx = [args.query && `"${args.query}"`, args.topic && `topic:${args.topic}`].filter(Boolean).join(', ')
          return { content: [{ type: 'text' as const, text: `No facts found for ${searchCtx}` }] }
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
}

function makeDeleteFactTool(chatIdStr: string, usedTools: Set<string>): SdkMcpToolDefinition<any> {
  return tool(
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
}

// --- Session naming tool factory ---

function makeNameSessionTool(chatIdStr: string, usedTools: Set<string>): SdkMcpToolDefinition<any> {
  return tool(
    'NameSession',
    'Give this session a short descriptive title (3-5 words). Call after 2nd user message when you understand the session topic. Title appears in session list (Claude Code /resume and Telegram /session).',
    { title: z.string().describe('Short session title, 3-5 words, in the language of the conversation') },
    async (args) => {
      usedTools.add('NameSession')
      try {
        const { getSession } = await import('./db.js')
        const sessionId = getSession(chatIdStr)
        if (!sessionId) {
          return { content: [{ type: 'text' as const, text: 'No active session' }], isError: true }
        }
        const { writeSessionTitle } = await import('./session-titles.js')
        writeSessionTitle(sessionId, args.title)
        return { content: [{ type: 'text' as const, text: `Session named: ${args.title}` }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err }, 'NameSession tool failed')
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
    }
  )
}

// --- Consolidation MCP server (memory tools only, no grammy Context needed) ---

export function createConsolidationMcpServer(chatId: number): BuiltinToolsResult {
  const chatIdStr = String(chatId)
  const usedTools = new Set<string>()
  const tools: SdkMcpToolDefinition<any>[] = [
    makeSaveFactTool(chatIdStr, usedTools),
    makeSearchMemoryTool(chatIdStr, usedTools),
    makeDeleteFactTool(chatIdStr, usedTools),
  ]

  const server = createSdkMcpServer({
    name: 'consolidation-builtin',
    version: '1.0.0',
    tools,
  })

  logger.debug({ chatId }, 'Consolidation MCP server created (SaveFact, SearchMemory, DeleteFact)')

  return { server, usedTools }
}
