import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Context } from 'grammy'
import { InputFile } from 'grammy'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'
import { TELEGRAPH_ENABLED } from './config.js'

export interface BuiltinToolsResult {
  server: McpSdkServerConfigWithInstance
  usedTools: Set<string>
}

export function createBuiltinMcpServer(ctx: Context, chatId: number): BuiltinToolsResult | null {
  const env = readEnvFile()
  const usedTools = new Set<string>()
  const tools: SdkMcpToolDefinition<any>[] = []

  const hasGoogleApi = !!env['GOOGLE_API_KEY']
  const hasPublishSsh = !!env['PUBLISH_SSH_HOST']

  // --- Image generation tools (require GOOGLE_API_KEY) ---

  if (hasGoogleApi) {
    tools.push(
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

    tools.push(
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

  tools.push(
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

  if (TELEGRAPH_ENABLED) {
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

  if (hasPublishSsh) {
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

  tools.push(
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

  tools.push(
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

  tools.push(
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

  tools.push(
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

  tools.push(
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

  tools.push(
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

  tools.push(
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

  tools.push(
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

  // --- Telegram media sending (always available) ---

  tools.push(
    tool(
      'SendPhoto',
      'Send a photo from a local file to the chat.',
      {
        filePath: z.string().describe('Absolute path to the image file'),
        caption: z.string().optional().describe('Optional caption for the photo'),
      },
      async (args) => {
        usedTools.add('SendPhoto')
        try {
          await ctx.replyWithChatAction('upload_photo')
          await ctx.replyWithPhoto(new InputFile(args.filePath), {
            caption: args.caption?.slice(0, 1024),
          })
          return { content: [{ type: 'text' as const, text: 'Photo sent' }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SendPhoto tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  tools.push(
    tool(
      'SendDocument',
      'Send a document/file to the chat.',
      {
        filePath: z.string().describe('Absolute path to the file to send'),
        caption: z.string().optional().describe('Optional caption for the document'),
      },
      async (args) => {
        usedTools.add('SendDocument')
        try {
          await ctx.replyWithChatAction('upload_document')
          await ctx.replyWithDocument(new InputFile(args.filePath), {
            caption: args.caption?.slice(0, 1024),
          })
          return { content: [{ type: 'text' as const, text: 'Document sent' }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SendDocument tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  tools.push(
    tool(
      'SendVoice',
      'Send a voice message from an audio file to the chat.',
      { filePath: z.string().describe('Absolute path to the audio file') },
      async (args) => {
        usedTools.add('SendVoice')
        try {
          await ctx.replyWithChatAction('upload_voice')
          await ctx.replyWithVoice(new InputFile(args.filePath))
          return { content: [{ type: 'text' as const, text: 'Voice sent' }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SendVoice tool failed')
          return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
        }
      }
    )
  )

  tools.push(
    tool(
      'SendVideo',
      'Send a video to the chat.',
      {
        filePath: z.string().describe('Absolute path to the video file'),
        caption: z.string().optional().describe('Optional caption for the video'),
      },
      async (args) => {
        usedTools.add('SendVideo')
        try {
          await ctx.replyWithChatAction('upload_video')
          await ctx.replyWithVideo(new InputFile(args.filePath), {
            caption: args.caption?.slice(0, 1024),
          })
          return { content: [{ type: 'text' as const, text: 'Video sent' }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ err }, 'SendVideo tool failed')
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
