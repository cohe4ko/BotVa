import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, WebSocket } from 'ws'
import { exec } from 'child_process'
import { provision } from './provisioner.js'
import type { ProvisionParams } from './steps.js'
import type { ClientChannel } from 'ssh2'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '3456', 10)
const IS_LOCAL = !process.env.PORT && !process.env.RENDER && !process.env.RAILWAY_ENVIRONMENT && !process.env.FLY_APP_NAME

const app = new Hono()

// Serve static index.html
app.get('/', (c) => {
  const html = readFileSync(join(__dirname, 'static', 'index.html'), 'utf-8')
  return c.html(html)
})

// Start HTTP server
const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  const url = `http://localhost:${PORT}`
  console.log(`\n  BotVa Installer: ${url}\n`)

  // Auto-open browser only when running locally
  if (IS_LOCAL) {
    const cmd = process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "${url}"`
        : `xdg-open "${url}" 2>/dev/null || true`
    exec(cmd)
  }
})

// WebSocket server
const wss = new WebSocketServer({ server: server as any })

wss.on('connection', (ws: WebSocket) => {
  let interactiveChannel: ClientChannel | null = null

  ws.on('message', (raw: Buffer) => {
    let msg: any
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      // Binary/text data for interactive terminal input
      if (interactiveChannel) {
        interactiveChannel.write(raw.toString())
      }
      return
    }

    if (msg.type === 'start') {
      handleStart(ws, msg.params)
    } else if (msg.type === 'input' && interactiveChannel) {
      interactiveChannel.write(msg.data)
    } else if (msg.type === 'interactive-done' && interactiveChannel) {
      // User signals interactive step is complete (e.g., Ctrl+D or explicit button)
      interactiveChannel.end()
    }
  })

  function handleStart(ws: WebSocket, params: ProvisionParams) {
    const send = (type: string, data: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...data }))
      }
    }

    provision(params, {
      onOutput: (data) => send('output', { data }),

      onStep: (index, total, name, status) => {
        send('step', { index, total, name, status })
      },

      onInteractive: (step, channel) => {
        interactiveChannel = channel

        send('interactive', {
          instruction: step.instruction || '',
          name: step.name,
        })

        // Stream channel output to browser
        channel.on('data', (data: Buffer) => {
          send('output', { data: data.toString() })
        })
        channel.stderr.on('data', (data: Buffer) => {
          send('output', { data: data.toString() })
        })

        return new Promise<void>((resolve) => {
          channel.on('close', () => {
            interactiveChannel = null
            resolve()
          })
        })
      },

      onDone: (success, message) => {
        send('done', { success, message })
      },
    })
  }
})
