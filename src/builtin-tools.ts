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
