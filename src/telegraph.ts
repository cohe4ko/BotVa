import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { STORE_DIR, BOT_NAME } from './config.js'
import { logger } from './logger.js'

interface TelegraphAccount {
  access_token: string
  auth_url: string
  short_name: string
}

let telegraphAccount: TelegraphAccount | null = null

const TELEGRAPH_THRESHOLD = 2500

export function shouldUseTelegraph(content: string): boolean {
  return content.length > TELEGRAPH_THRESHOLD
}

export async function initTelegraph(): Promise<void> {
  try {
    const accountFile = path.join(STORE_DIR, 'telegraph-account.json')

    if (fs.existsSync(accountFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(accountFile, 'utf-8'))
        if (raw.access_token && raw.short_name) {
          telegraphAccount = raw
          logger.debug('Telegraph account loaded')
          return
        }
      } catch {
        logger.warn('Malformed telegraph account file, creating new')
      }
    }

    const response = await fetch('https://api.telegra.ph/createAccount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        short_name: 'BotVa',
        author_name: BOT_NAME,
        author_url: 'https://github.com/anthropics/claude-code'
      })
    })

    if (!response.ok) {
      throw new Error(`Telegraph API error: ${response.statusText}`)
    }

    const json = await response.json() as {
      ok: boolean
      result?: { access_token?: string; auth_url?: string; short_name?: string }
      error?: string
    }

    if (!json.ok || !json.result?.access_token) {
      throw new Error(json.error || 'Unknown Telegraph API error')
    }

    telegraphAccount = {
      access_token: json.result.access_token,
      auth_url: json.result.auth_url || '',
      short_name: json.result.short_name || 'BotVa'
    }

    fs.writeFileSync(accountFile, JSON.stringify(telegraphAccount, null, 2), { mode: 0o600 })
    logger.info('Telegraph account created')
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Telegraph')
  }
}

// --- Markdown to Telegraph nodes ---

type TelegraphTag = 'a' | 'aside' | 'b' | 'blockquote' | 'br' | 'code' | 'em' |
  'figcaption' | 'figure' | 'h3' | 'h4' | 'hr' | 'i' | 'iframe' | 'img' |
  'li' | 'ol' | 'p' | 'pre' | 's' | 'strong' | 'u' | 'ul' | 'video'

type TelegraphNode = string | {
  tag: TelegraphTag
  attrs?: { href?: string; src?: string }
  children?: TelegraphNode[]
}

function parseInline(text: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = []
  let remaining = text

  const patterns: Array<{
    regex: RegExp
    handler: (match: RegExpMatchArray) => TelegraphNode
  }> = [
    { regex: /\[([^\]]+)\]\(([^)]+)\)/, handler: (m) => ({ tag: 'a', attrs: { href: m[2] }, children: [m[1]] }) },
    { regex: /\*\*\*(.+?)\*\*\*/, handler: (m) => ({ tag: 'b', children: [{ tag: 'i', children: [m[1]] }] }) },
    { regex: /\*\*(.+?)\*\*/, handler: (m) => ({ tag: 'b', children: [m[1]] }) },
    { regex: /__(.+?)__/, handler: (m) => ({ tag: 'b', children: [m[1]] }) },
    { regex: /\*(.+?)\*/, handler: (m) => ({ tag: 'i', children: [m[1]] }) },
    { regex: /(?<!\w)_(.+?)_(?!\w)/, handler: (m) => ({ tag: 'i', children: [m[1]] }) },
    { regex: /~~(.+?)~~/, handler: (m) => ({ tag: 's', children: [m[1]] }) },
    { regex: /`([^`]+)`/, handler: (m) => ({ tag: 'code', children: [m[1]] }) },
  ]

  while (remaining.length > 0) {
    let earliestMatch: { index: number; length: number; node: TelegraphNode } | null = null

    for (const pattern of patterns) {
      const match = remaining.match(pattern.regex)
      if (match && match.index !== undefined) {
        if (!earliestMatch || match.index < earliestMatch.index) {
          earliestMatch = { index: match.index, length: match[0].length, node: pattern.handler(match) }
        }
      }
    }

    if (earliestMatch) {
      if (earliestMatch.index > 0) nodes.push(remaining.slice(0, earliestMatch.index))
      nodes.push(earliestMatch.node)
      remaining = remaining.slice(earliestMatch.index + earliestMatch.length)
    } else {
      nodes.push(remaining)
      break
    }
  }

  return nodes
}

function markdownToNodes(markdown: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = []
  const lines = markdown.split('\n')
  let inCodeBlock = false
  let codeBlockContent = ''
  let inList: 'ul' | 'ol' | null = null
  let listItems: TelegraphNode[] = []
  let pendingParagraphLines: string[] = []
  let tableHeaders: string[] = []

  const flushParagraph = () => {
    if (pendingParagraphLines.length === 0) return
    const children: TelegraphNode[] = []
    for (let j = 0; j < pendingParagraphLines.length; j++) {
      if (j > 0) children.push({ tag: 'br' })
      children.push(...parseInline(pendingParagraphLines[j]))
    }
    nodes.push({ tag: 'p', children })
    pendingParagraphLines = []
  }

  const flushList = () => {
    if (inList && listItems.length > 0) {
      nodes.push({ tag: inList, children: listItems })
      listItems = []
      inList = null
    }
  }

  const flushAll = () => { flushParagraph(); flushList() }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('```')) {
      flushAll()
      if (inCodeBlock) {
        nodes.push({ tag: 'pre', children: [{ tag: 'code', children: [codeBlockContent.trimEnd()] }] })
        inCodeBlock = false
        codeBlockContent = ''
      } else {
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) { codeBlockContent += line + '\n'; continue }

    if (line.trim() === '') { flushAll(); continue }

    if (/^[-*_]{3,}\s*$/.test(line)) { flushAll(); nodes.push({ tag: 'hr' }); continue }

    if (line.startsWith('#### ')) { flushAll(); nodes.push({ tag: 'h4', children: parseInline(line.slice(5)) }); continue }
    if (line.startsWith('### ')) { flushAll(); nodes.push({ tag: 'h4', children: parseInline(line.slice(4)) }); continue }
    if (line.startsWith('## ')) { flushAll(); nodes.push({ tag: 'h3', children: parseInline(line.slice(3)) }); continue }
    if (line.startsWith('# ')) { flushAll(); nodes.push({ tag: 'h3', children: parseInline(line.slice(2)) }); continue }

    if (line.match(/^[\s]*[-*+]\s+/)) {
      flushParagraph()
      if (inList !== 'ul') { flushList(); inList = 'ul' }
      listItems.push({ tag: 'li', children: parseInline(line.replace(/^[\s]*[-*+]\s+/, '')) })
      continue
    }

    const orderedMatch = line.match(/^[\s]*(\d+)\.\s+(.*)$/)
    if (orderedMatch) {
      flushParagraph()
      if (inList !== 'ol') { flushList(); inList = 'ol' }
      listItems.push({ tag: 'li', children: parseInline(orderedMatch[2]) })
      continue
    }

    if (line.startsWith('> ')) { flushAll(); nodes.push({ tag: 'blockquote', children: parseInline(line.slice(2)) }); continue }

    // Table handling
    if (line.includes('|') && line.trim().startsWith('|')) {
      flushAll()
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim())
      if (cells.length > 0 && cells.every(c => /^[-:]+$/.test(c))) continue

      const nextLine = i + 1 < lines.length ? lines[i + 1] : ''
      const nextCells = nextLine.split('|').filter(c => c.trim()).map(c => c.trim())
      const isHeader = nextCells.length > 0 && nextCells.every(c => /^[-:]+$/.test(c))

      if (isHeader && cells.length > 0) {
        tableHeaders = cells
        nodes.push({ tag: 'p', children: [{ tag: 'b', children: [cells.join('  ·  ')] }] })
        continue
      }

      if (tableHeaders.length > 0 && cells.length > 0) {
        const parts: TelegraphNode[] = []
        cells.forEach((cell, idx) => {
          if (idx > 0) parts.push('  |  ')
          if (tableHeaders[idx]) parts.push({ tag: 'b', children: [tableHeaders[idx] + ': '] })
          parts.push(cell)
        })
        nodes.push({ tag: 'p', children: parts })
      } else if (cells.length > 0) {
        nodes.push({ tag: 'p', children: [cells.join('  |  ')] })
      }
      continue
    }

    flushList()
    pendingParagraphLines.push(line)
  }

  flushAll()

  if (inCodeBlock && codeBlockContent) {
    nodes.push({ tag: 'pre', children: [{ tag: 'code', children: [codeBlockContent.trimEnd()] }] })
  }

  return nodes
}

export async function createTelegraphPage(
  title: string,
  markdown: string
): Promise<string | null> {
  if (!telegraphAccount) await initTelegraph()
  if (!telegraphAccount) return null

  try {
    const content = markdownToNodes(markdown)
    const uuidTitle = randomUUID()

    const contentWithTitle: TelegraphNode[] = [
      { tag: 'h3', children: [title] },
      ...content
    ]

    const response = await fetch('https://api.telegra.ph/createPage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: telegraphAccount.access_token,
        title: uuidTitle,
        author_name: BOT_NAME,
        content: contentWithTitle,
        return_content: false
      })
    })

    if (!response.ok) throw new Error(`Telegraph API error: ${response.statusText}`)

    const json = await response.json() as { ok: boolean; result?: { url?: string }; error?: string }

    if (!json.ok || !json.result?.url) throw new Error(json.error || 'Unknown Telegraph API error')

    return json.result.url
  } catch (error) {
    logger.error({ error }, 'Failed to create Telegraph page')
    return null
  }
}
