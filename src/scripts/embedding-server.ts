/**
 * Embedding Service — shared process for semantic search.
 * Listens on Unix socket, serves text embeddings via multilingual-e5-small.
 *
 * Protocol (JSON lines over Unix socket):
 *   Request:  { action: 'embed', texts: string[], type: 'query' | 'passage' } + '\n'
 *   Response: { embeddings: number[][] } + '\n'
 *
 *   Request:  { action: 'health' } + '\n'
 *   Response: { ready: boolean, model: string, uptime: number } + '\n'
 */

import { createServer as createNetServer } from 'net'
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const STORE_DIR = resolve(PROJECT_ROOT, 'store')
const SOCK_PATH = process.env['EMBEDDING_SOCK_PATH'] ?? resolve(STORE_DIR, 'embedding.sock')
const PID_FILE = resolve(STORE_DIR, 'embedding.pid')

const MODEL_NAME = 'intfloat/multilingual-e5-small'
const startTime = Date.now()

let pipeline: any = null
let ready = false
let requestCount = 0
let textsEmbedded = 0

async function loadModel(): Promise<void> {
  console.log(`Loading model: ${MODEL_NAME}...`)
  const { pipeline: createPipeline } = await import('@huggingface/transformers')
  pipeline = await createPipeline('feature-extraction', MODEL_NAME, {
    dtype: 'fp32',
    device: 'cpu',
  })
  ready = true
  console.log(`Model loaded in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
}

async function embed(texts: string[], type: 'query' | 'passage'): Promise<number[][]> {
  const prefix = type === 'query' ? 'query: ' : 'passage: '
  const prefixed = texts.map(t => prefix + t)
  const output = await pipeline(prefixed, { pooling: 'mean', normalize: true })
  const data: number[][] = []
  for (let i = 0; i < texts.length; i++) {
    data.push(Array.from(output[i].data as Float32Array))
  }
  return data
}

function startServer(): void {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH)

  const server = createNetServer((conn) => {
    let buf = ''
    const timeout = setTimeout(() => { conn.destroy() }, 60_000)

    conn.on('data', (chunk) => {
      buf += chunk.toString()
      let nlIndex: number
      while ((nlIndex = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nlIndex)
        buf = buf.slice(nlIndex + 1)

        clearTimeout(timeout)

        let req: any
        try {
          req = JSON.parse(line)
        } catch {
          conn.write(JSON.stringify({ error: 'Invalid JSON' }) + '\n')
          conn.end()
          return
        }

        if (req.action === 'health') {
          conn.write(JSON.stringify({
            ready,
            model: MODEL_NAME,
            uptime: Math.floor((Date.now() - startTime) / 1000),
            requestCount,
            textsEmbedded,
          }) + '\n')
          conn.end()
          return
        }

        if (req.action === 'embed') {
          if (!ready) {
            conn.write(JSON.stringify({ error: 'Model not loaded yet' }) + '\n')
            conn.end()
            return
          }
          const texts: string[] = req.texts ?? []
          const type: 'query' | 'passage' = req.type ?? 'passage'
          if (texts.length === 0) {
            conn.write(JSON.stringify({ embeddings: [] }) + '\n')
            conn.end()
            return
          }
          requestCount++
          textsEmbedded += texts.length
          embed(texts, type)
            .then(embeddings => {
              conn.write(JSON.stringify({ embeddings }) + '\n')
              conn.end()
            })
            .catch(err => {
              conn.write(JSON.stringify({ error: String(err) }) + '\n')
              conn.end()
            })
          return
        }

        conn.write(JSON.stringify({ error: `Unknown action: ${req.action}` }) + '\n')
        conn.end()
      }
    })

    conn.on('error', () => { clearTimeout(timeout) })
  })

  server.listen(SOCK_PATH, () => {
    console.log(`Embedding service listening on ${SOCK_PATH}`)
  })

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid))

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down...')
    server.close()
    try { unlinkSync(SOCK_PATH) } catch {}
    try { unlinkSync(PID_FILE) } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Main
startServer()
loadModel().catch(err => {
  console.error('Failed to load model:', err)
  process.exit(1)
})
