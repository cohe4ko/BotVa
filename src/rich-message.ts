import { marked } from 'marked'
import type { Token, Tokens } from 'marked'
import type { InputRichMessage } from '@grammyjs/types'

// --- Ліміти Rich Message (Bot API 10.1, див. node_modules/@grammyjs/types/rich.d.ts) ---
// До 32768 UTF-8 символів у тексті rich-повідомлення. Тримаємо запас під розмітку.
export const RICH_MESSAGE_MAX_CHARS = 30000

// InputRichMessage приймає РІВНО одне з полів html/markdown (не blocks — блоки
// існують лише у ВХІДНИХ повідомленнях). Ми будуємо Rich HTML: теги мапляться
// 1:1 на документовані RichBlock/RichText типи (<h1>..<h6>, <pre><code>, <ul>/<ol>,
// <blockquote>, <table>, <hr/>, <b>/<i>/<s>/<code>/<tg-spoiler>/<mark>/<a>).

/** Екранування для Rich HTML тексту. API підтримує числові сутності + невеликий
 *  набір іменованих; безпечно екрануємо тільки &, <, >. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Екранування значення атрибута (напр. href). */
function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

/** marked не парсить ||spoiler|| та ==mark==; додаємо їх на рівні plain-text. */
function applyInlineExtras(escaped: string): string {
  return escaped
    .replace(/\|\|(.+?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>')
}

/** Рендер масиву inline-токенів marked у Rich HTML. */
function renderInline(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''
  let out = ''
  for (const tok of tokens) {
    const t = tok as any
    switch (t.type) {
      case 'text': {
        // Вкладені inline-токени (напр. усередині пункту списку) — рекурсія
        if (t.tokens && t.tokens.length) {
          out += renderInline(t.tokens)
        } else {
          out += applyInlineExtras(escapeHtml(String(t.text ?? '')))
        }
        break
      }
      case 'escape':
        out += escapeHtml(String(t.text ?? ''))
        break
      case 'strong':
        out += `<b>${renderInline(t.tokens)}</b>`
        break
      case 'em':
        out += `<i>${renderInline(t.tokens)}</i>`
        break
      case 'del':
        out += `<s>${renderInline(t.tokens)}</s>`
        break
      case 'codespan':
        out += `<code>${escapeHtml(String(t.text ?? ''))}</code>`
        break
      case 'link': {
        const href = String(t.href ?? '')
        const inner = renderInline(t.tokens) || escapeHtml(String(t.text ?? ''))
        out += href ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner
        break
      }
      case 'image': {
        // Inline-зображення в Rich HTML можуть бути лише окремим медіа-блоком —
        // тут показуємо alt-текст, щоб не ламати структуру.
        out += applyInlineExtras(escapeHtml(String(t.text ?? '')))
        break
      }
      case 'br':
        out += '<br>'
        break
      case 'html':
        out += escapeHtml(String(t.text ?? t.raw ?? ''))
        break
      default:
        out += applyInlineExtras(escapeHtml(String(t.text ?? '')))
    }
  }
  return out
}

/** Rich HTML для одного пункту списку (з підтримкою вкладених списків). */
function renderListItem(item: Tokens.ListItem): string {
  let prefix = ''
  if ((item as any).task) {
    prefix = `<input type="checkbox"${(item as any).checked ? ' checked' : ''}>`
  }
  let body = ''
  for (const child of item.tokens ?? []) {
    const c = child as any
    if (c.type === 'checkbox') continue // прапорець уже відрендерено через item.task
    if (c.type === 'list') {
      body += renderList(c as Tokens.List)
    } else if (c.type === 'text' || c.type === 'paragraph') {
      body += renderInline(c.tokens ?? [{ type: 'text', text: c.text }] as any)
    } else {
      body += renderBlock(child)
    }
  }
  return `<li>${prefix}${body}</li>`
}

/** Rich HTML для списку <ul>/<ol>. */
function renderList(token: Tokens.List): string {
  const tag = token.ordered ? 'ol' : 'ul'
  const startNum = Number(token.start)
  const startAttr = token.ordered && Number.isFinite(startNum) && startNum !== 1
    ? ` start="${startNum}"`
    : ''
  const items = token.items.map(renderListItem).join('')
  return `<${tag}${startAttr}>${items}</${tag}>`
}

/** Rich HTML для таблиці. Клітинки — тільки inline-форматування. */
function renderTable(token: Tokens.Table): string {
  const alignAttr = (a: string | null) => (a ? ` align="${a}"` : '')
  const head = '<tr>' + token.header
    .map(cell => `<th${alignAttr(cell.align)}>${renderInline(cell.tokens)}</th>`)
    .join('') + '</tr>'
  const body = token.rows
    .map(row => '<tr>' + row
      .map(cell => `<td${alignAttr(cell.align)}>${renderInline(cell.tokens)}</td>`)
      .join('') + '</tr>')
    .join('')
  return `<table>${head}${body}</table>`
}

/** Блок-цитата: пласко зводимо вкладені параграфи в inline з <br>. */
function renderBlockquote(token: Tokens.Blockquote): string {
  const parts: string[] = []
  for (const child of token.tokens ?? []) {
    const c = child as any
    if (c.type === 'paragraph' || c.type === 'text') {
      parts.push(renderInline(c.tokens ?? [{ type: 'text', text: c.text }] as any))
    } else {
      parts.push(renderBlock(child))
    }
  }
  return `<blockquote>${parts.filter(p => p.length > 0).join('<br><br>')}</blockquote>`
}

/** Rich HTML для одного блок-токена. */
function renderBlock(token: Token): string {
  const t = token as any
  switch (t.type) {
    case 'space':
      return ''
    case 'heading': {
      const depth = Math.min(6, Math.max(1, Number(t.depth) || 1))
      return `<h${depth}>${renderInline(t.tokens)}</h${depth}>`
    }
    case 'paragraph':
      return `<p>${renderInline(t.tokens)}</p>`
    case 'text':
      return `<p>${t.tokens ? renderInline(t.tokens) : applyInlineExtras(escapeHtml(String(t.text ?? '')))}</p>`
    case 'code': {
      const escaped = escapeHtml(String(t.text ?? ''))
      const lang = String(t.lang ?? '').trim().split(/\s+/)[0]
      return lang
        ? `<pre><code class="language-${escapeAttr(lang)}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`
    }
    case 'hr':
      return '<hr/>'
    case 'blockquote':
      return renderBlockquote(t as Tokens.Blockquote)
    case 'list':
      return renderList(t as Tokens.List)
    case 'table':
      return renderTable(t as Tokens.Table)
    case 'html':
      // Сирий HTML від агента не очікується; екрануємо як параграф.
      return `<p>${escapeHtml(String(t.text ?? t.raw ?? ''))}</p>`
    default:
      return t.text ? `<p>${applyInlineExtras(escapeHtml(String(t.text)))}</p>` : ''
  }
}

/** Конвертує markdown-відповідь агента у Rich HTML рядок. */
export function markdownToRichHtml(md: string): string {
  const tokens = marked.lexer(md)
  let html = ''
  for (const token of tokens) {
    html += renderBlock(token)
  }
  return html.trim()
}

/** Конвертує markdown у InputRichMessage (Rich HTML). */
export function markdownToRichMessage(md: string): InputRichMessage {
  return { html: markdownToRichHtml(md) }
}

/** Розбиває довгий markdown на блок-межах так, щоб кожен фрагмент вкладався у ліміт. */
function splitMarkdown(md: string, maxChars: number): string[] {
  if (md.length <= maxChars) return [md]

  const blocks = md.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''

  const pushHardSplit = (block: string) => {
    // Один блок більший за ліміт — ріжемо по рядках, у крайньому разі по символах.
    let rest = block
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf('\n', maxChars)
      if (cut <= 0) cut = maxChars
      chunks.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut)
    }
    if (rest.trim()) current = rest
  }

  for (const block of blocks) {
    if (block.length > maxChars) {
      if (current.trim()) { chunks.push(current.trim()); current = '' }
      pushHardSplit(block)
      continue
    }
    const candidate = current ? `${current}\n\n${block}` : block
    if (candidate.length > maxChars) {
      if (current.trim()) chunks.push(current.trim())
      current = block
    } else {
      current = candidate
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(c => c.length > 0)
}

/** Конвертує markdown у одне або кілька InputRichMessage з урахуванням лімітів. */
export function markdownToRichMessages(
  md: string,
  maxChars = RICH_MESSAGE_MAX_CHARS,
): InputRichMessage[] {
  return splitMarkdown(md, maxChars).map(markdownToRichMessage)
}

/** Простий InputRichMessage для стрімінгу чернетки (partial markdown, як є). */
export function draftRichMessage(partial: string): InputRichMessage {
  return { markdown: partial }
}
