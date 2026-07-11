import { MAX_MESSAGE_LENGTH } from './config.js'
import type { UsageStats } from './agent.js'
import type { Context, InlineKeyboard } from 'grammy'

// --- HTML escaping ---

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// --- Markdown → Telegram HTML ---

export function formatForTelegram(text: string): string {
  // Extract and protect code blocks
  const codeBlocks: string[] = []
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.trimEnd())
    const idx = codeBlocks.length
    codeBlocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escaped}</code></pre>`)
    return `%%CODEBLOCK_${idx}%%`
  })

  // Protect inline code
  const inlineCodes: string[] = []
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `%%INLINE_${idx}%%`
  })

  // Convert markdown tables to readable list format
  processed = processed.replace(
    /((?:^\|.+\|[ \t]*\n){2,})/gm,
    (tableBlock) => {
      const rows = tableBlock.trim().split('\n').map(row =>
        row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      )
      // Skip separator rows (---|---)
      const dataRows = rows.filter(row => !row.every(cell => /^[-:\s]+$/.test(cell)))
      if (dataRows.length < 2) return tableBlock

      const headers = dataRows[0]
      const body = dataRows.slice(1)
      return body.map(row =>
        row.map((cell, i) => {
          const header = headers[i]
          if (!cell) return ''
          return header ? `**${header}:** ${cell}` : cell
        }).filter(Boolean).join('\n')
      ).join('\n\n') + '\n'
    }
  )

  // Escape HTML in remaining text
  processed = escapeHtml(processed)

  // Restore code placeholders (already escaped inside)
  processed = processed.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => codeBlocks[Number(i)])
  processed = processed.replace(/%%INLINE_(\d+)%%/g, (_, i) => inlineCodes[Number(i)])

  // Expandable blockquotes: >> lines grouped into <blockquote expandable>
  processed = processed.replace(
    /(?:^&gt;&gt;\s?(.*)$\n?)+/gm,
    (match) => {
      const content = match.trimEnd().replace(/^&gt;&gt;\s?/gm, '')
      return `<blockquote expandable>${content}</blockquote>`
    }
  )

  // Regular blockquotes: > lines grouped into <blockquote>
  processed = processed.replace(
    /(?:^&gt;\s?(.*)$\n?)+/gm,
    (match) => {
      const content = match.trimEnd().replace(/^&gt;\s?/gm, '')
      return `<blockquote>${content}</blockquote>`
    }
  )

  // Headings → bold
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic: *text* or _text_ (not inside words)
  processed = processed.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>')
  processed = processed.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>')

  // Strikethrough
  processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Spoiler: ||text||
  processed = processed.replace(/\|\|(.+?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Checkboxes
  processed = processed.replace(/^- \[ \]/gm, '☐')
  processed = processed.replace(/^- \[x\]/gm, '☑')

  // Strip horizontal rules
  processed = processed.replace(/^[-*_]{3,}$/gm, '')

  return processed.trim()
}

// --- Smart message splitter ---

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text
  let inPre = false

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      if (inPre) remaining += '</code></pre>'
      chunks.push(remaining)
      break
    }

    let chunk = remaining.substring(0, limit)
    let splitIndex = limit

    // Track <pre> state in this chunk
    let tempInPre = inPre
    const preOpenRegex = /<pre><code[^>]*>/g
    const preCloseRegex = /<\/code><\/pre>/g
    let match: RegExpExecArray | null

    // Count opens
    while ((match = preOpenRegex.exec(chunk)) !== null) {
      tempInPre = true
    }
    // Count closes
    while ((match = preCloseRegex.exec(chunk)) !== null) {
      tempInPre = false
    }

    if (!tempInPre) {
      // Not in a code block: split at natural boundaries
      const paragraphBreak = chunk.lastIndexOf('\n\n')
      if (paragraphBreak > limit / 2) {
        splitIndex = paragraphBreak + 2
      } else {
        const newlineBreak = chunk.lastIndexOf('\n')
        if (newlineBreak > limit / 2) {
          splitIndex = newlineBreak + 1
        } else {
          const spaceBreak = chunk.lastIndexOf(' ')
          if (spaceBreak > limit / 2) {
            splitIndex = spaceBreak + 1
          }
        }
      }
    } else {
      // In a code block: try to split at a newline
      const newlineSplit = chunk.lastIndexOf('\n')
      if (newlineSplit > limit / 2) {
        splitIndex = newlineSplit + 1
      }
    }

    chunk = remaining.substring(0, splitIndex)

    // Recount <pre> state in the adjusted chunk
    tempInPre = inPre
    const adjustedOpenRegex = /<pre><code[^>]*>/g
    const adjustedCloseRegex = /<\/code><\/pre>/g
    while ((match = adjustedOpenRegex.exec(chunk)) !== null) tempInPre = true
    while ((match = adjustedCloseRegex.exec(chunk)) !== null) tempInPre = false

    // If ending inside a code block, close it
    if (tempInPre) {
      chunk = chunk.trimEnd() + '</code></pre>'
      inPre = true
    } else {
      inPre = false
    }

    chunks.push(chunk)
    remaining = remaining.substring(splitIndex).trimStart()

    // If we were in a code block, reopen it
    if (inPre && remaining.length > 0) {
      remaining = '<pre><code>' + remaining
    }
  }

  // Add part indicators
  if (chunks.length > 1) {
    return chunks.map((part, i) => {
      const indicator = `\n\n<i>[${i + 1}/${chunks.length}]</i>`
      if (part.length + indicator.length <= limit) {
        return part + indicator
      }
      return part
    })
  }

  return chunks
}

// --- Usage stats formatting ---

export function formatUsageStats(u: UsageStats): string {
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  const cost = u.costUSD >= 0.01 ? `$${u.costUSD.toFixed(2)}` : `$${u.costUSD.toFixed(4)}`
  const contextPct = u.contextWindow > 0
    ? ((u.lastTurnContextTokens / u.contextWindow) * 100).toFixed(0)
    : '?'

  return `<i>${cost} | ctx: ${contextPct}% (${k(u.lastTurnContextTokens)}/${k(u.contextWindow)}) | in: ${k(u.inputTokens)} out: ${k(u.outputTokens)}</i>`
}

// --- Telegraph button threshold ---

/** Довгі відповіді (> цього ліміту символів) отримують інлайн-кнопку «В Telegraph». */
export const TELEGRAPH_BUTTON_THRESHOLD = 5000

/** Чи пропонувати кнопку «В Telegraph» під відповіддю такої довжини. */
export function shouldOfferTelegraphButton(text: string): boolean {
  return text.length > TELEGRAPH_BUTTON_THRESHOLD
}

// --- Send chunked message ---

export async function sendChunked(
  ctx: Context,
  text: string,
  lastReplyMarkup?: InlineKeyboard
): Promise<void> {
  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const isLast = i === chunks.length - 1
    const markup = isLast ? lastReplyMarkup : undefined
    try {
      await ctx.reply(chunk, { parse_mode: 'HTML', reply_markup: markup })
    } catch {
      await ctx.reply(chunk.replace(/<[^>]+>/g, ''), { reply_markup: markup })
    }
  }
}
