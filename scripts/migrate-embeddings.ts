// Backfill embeddings for existing facts.
// Scans bots/<name>/store/botva.db, embeds facts missing embeddings.
// Usage: npx tsx scripts/migrate-embeddings.ts

import { existsSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { DatabaseSync } from 'node:sqlite'
import { connect } from 'net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const BOTS_DIR = resolve(PROJECT_ROOT, 'bots')
const SOCK_PATH = process.env['EMBEDDING_SOCK_PATH'] ?? resolve(PROJECT_ROOT, 'store', 'embedding.sock')
const BATCH_SIZE = 20

interface EmbedResponse {
  embeddings?: number[][]
  error?: string
}

function sendRequest(request: object, timeoutMs: number): Promise<EmbedResponse> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCK_PATH)
    let data = ''
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('Timeout'))
    }, timeoutMs)

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n')
    })

    sock.on('data', (chunk) => {
      data += chunk.toString()
      const nlIdx = data.indexOf('\n')
      if (nlIdx !== -1) {
        clearTimeout(timer)
        try { resolve(JSON.parse(data.slice(0, nlIdx))) }
        catch { reject(new Error('Invalid response')) }
        sock.end()
      }
    })

    sock.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const force = process.argv.includes('--force')

async function main(): Promise<void> {
  // Check embedding service
  if (!existsSync(SOCK_PATH)) {
    console.error(`Embedding service not running (socket not found: ${SOCK_PATH})`)
    console.error('Start it first: tsx scripts/embedding-server.ts')
    process.exit(1)
  }

  try {
    const health = await sendRequest({ action: 'health' }, 5000)
    if (!health.ready) {
      console.error('Embedding service not ready (model still loading?)')
      process.exit(1)
    }
    console.log(`Embedding service: ready (model loaded)`)
  } catch (err) {
    console.error('Cannot connect to embedding service:', err)
    process.exit(1)
  }

  // Find all bot databases
  if (!existsSync(BOTS_DIR)) {
    console.log('No bots/ directory found')
    process.exit(0)
  }

  const botDirs = readdirSync(BOTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  let totalProcessed = 0
  let totalEmbedded = 0

  for (const botName of botDirs) {
    const dbPath = resolve(BOTS_DIR, botName, 'store', 'botva.db')
    if (!existsSync(dbPath)) continue

    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')

    // Add embedding column if missing
    try { db.exec('ALTER TABLE facts ADD COLUMN embedding BLOB') } catch { /* already exists */ }

    // Clear embeddings if --force (model changed, need re-embed)
    if (force) {
      db.exec('UPDATE facts SET embedding = NULL')
    }

    // Get facts without embeddings
    const facts = db.prepare(
      'SELECT id, content FROM facts WHERE embedding IS NULL'
    ).all() as unknown as { id: number; content: string }[]

    if (facts.length === 0) {
      console.log(`${botName}: no facts to embed`)
      continue
    }

    console.log(`${botName}: ${facts.length} facts to embed`)
    const updateStmt = db.prepare('UPDATE facts SET embedding = ? WHERE id = ?')
    let embedded = 0

    for (let i = 0; i < facts.length; i += BATCH_SIZE) {
      const batch = facts.slice(i, i + BATCH_SIZE)
      const texts = batch.map(f => f.content)

      try {
        const resp = await sendRequest(
          { action: 'embed', texts, type: 'passage' },
          30_000
        )

        if (resp.embeddings) {
          db.exec('BEGIN')
          for (let j = 0; j < batch.length; j++) {
            if (resp.embeddings[j]) {
              const buf = Buffer.from(new Float32Array(resp.embeddings[j]).buffer)
              updateStmt.run(buf, batch[j].id)
              embedded++
            }
          }
          db.exec('COMMIT')
        }
      } catch (err) {
        console.error(`  Error embedding batch: ${err}`)
      }

      console.log(`  ${botName}: ${Math.min(i + BATCH_SIZE, facts.length)}/${facts.length} facts processed`)
    }

    console.log(`${botName}: ${embedded}/${facts.length} facts embedded`)
    totalProcessed += facts.length
    totalEmbedded += embedded
    db.close()
  }

  console.log(`\nDone! ${totalEmbedded}/${totalProcessed} facts embedded across ${botDirs.length} bots`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
