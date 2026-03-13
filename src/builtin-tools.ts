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
    { name: 'SearchMemory', icon: 'brain', category: 'memory', description: 'Search bot memory by keywords', available: true },
    // Email
    { name: 'SendEmail', icon: 'mail', category: 'communication', description: 'Send email via SMTP', condition: 'SMTP_HOST + SMTP_USER + SMTP_PASS', available: hasSmtp },
    // Telegram media
    { name: 'SendMedia', icon: 'send', category: 'telegram', description: 'Send photo/document/voice/video to chat', available: true },
  ]

  return defs.map(d => ({ ...d, enabled: config[d.name] !== false }))
}

export interface BuiltinToolsResult {
  server: McpSdkServerConfigWithInstance
  usedTools: Set<string>
}

export function createBuiltinMcpServer(ctx: Context, chatId: number): BuiltinToolsResult | null {
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
      'List images in the gallery with metadata (id, bot, type, prompt, size, date). Supports pagination and optional bot name filter.',
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
          lines.unshift(`Gallery: ${total} images total, showing ${images.length}`)
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

  // --- Memory search ---

  if (isOn('SearchMemory')) tools.push(
    tool(
      'SearchMemory',
      'Search your memory for information about past conversations, facts, or events. Use this when the user asks about something you discussed before, or when you need to recall specific details. The automatic memory injection gives you recent context, but this tool lets you search deeper.',
      {
        query: z.string().describe('Keywords to search for in memory (e.g. "birthday", "project deadline", "doctor appointment")'),
        limit: z.number().optional().describe('Max results to return (default 10)'),
      },
      async (args) => {
        usedTools.add('SearchMemory')
        try {
          const chatIdStr = String(chatId)
          const { searchMemories, touchMemory } = await import('./db.js')
          const results = searchMemories(chatIdStr, args.query, args.limit ?? 10)
          if (results.length === 0) {
            return { content: [{ type: 'text' as const, text: `No memories found for "${args.query}"` }] }
          }
          // Boost salience for accessed memories
          for (const m of results) touchMemory(m.id)
          const lines = results.map(m => {
            const date = new Date(m.created_at * 1000).toISOString().slice(0, 10)
            const sector = m.sector === 'semantic' ? 'fact' : 'event'
            return `[${date}] (${sector}, salience: ${m.salience.toFixed(2)}) ${m.content}`
          })
          return { content: [{ type: 'text' as const, text: `Found ${results.length} memories:\n\n${lines.join('\n\n')}` }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SearchMemory tool failed')
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

  if (tools.length === 0) return null

  const server = createSdkMcpServer({
    name: 'builtin',
    version: '1.0.0',
    tools,
  })

  logger.debug({ toolCount: tools.length, tools: tools.map(t => t.name) }, 'Builtin MCP server created')

  return { server, usedTools }
}
