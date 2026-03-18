import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { alert, formatTs, truncate, pagination } from '../views/components.js'
import { getFacts, countFacts, getFactTopics, updateFactContent, deleteFact, getBotDir, getBotDb, type FactRow } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const app = new Hono<I18nEnv>()
const PAGE_SIZE = 30

const TOPIC_COLORS: Record<string, string> = {
  health: '#dcfce7',
  work: '#dbeafe',
  family: '#fce7f3',
  preferences: '#fef9c3',
  contacts: '#e0e7ff',
  projects: '#cffafe',
  education: '#f3e8ff',
  business: '#ffedd5',
  tech: '#d1d5db',
  hobbies: '#fbcfe8',
  finance: '#d9f99d',
  travel: '#bae6fd',
  food: '#fed7aa',
  goals: '#c4b5fd',
  decisions: '#fca5a5',
  general: '#e5e7eb',
}
function topicColor(topic: string): string {
  return TOPIC_COLORS[topic] || TOPIC_COLORS['general']
}

// Track active rebuild processes for cancel
const activeRebuilds = new Map<string, { abort: AbortController }>()

app.get('/bot/:name/facts', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = botName(c)
  const q = c.req.query('q') || ''
  const topicFilter = c.req.query('topic') || ''
  const page = parseInt(c.req.query('page') || '1', 10)
  const offset = (page - 1) * PAGE_SIZE

  let total = 0
  let facts: ReturnType<typeof getFacts> = []
  let topics: ReturnType<typeof getFactTopics> = []
  try {
    total = countFacts(name, q || undefined, topicFilter || undefined)
    facts = getFacts(name, PAGE_SIZE, offset, q || undefined, topicFilter || undefined)
    topics = getFactTopics(name)
  } catch { /* db may not exist */ }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (topicFilter) params.set('topic', topicFilter)
  const baseUrl = `/bot/${name}/facts${params.toString() ? `?${params}` : ''}`
  const isRebuilding = activeRebuilds.has(name)

  const content = html`
    ${botNav(name, 'facts', t)}
    <div class="section-header">
      <h3 style="margin:0">${icon('database')} ${t('facts.title')}</h3>
      <small>${total} ${total === 1 ? 'fact' : 'facts'}${topics.length > 0 ? `, ${topics.length} topics` : ''}</small>
    </div>
    ${topics.length > 0 ? html`
      <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.75rem">
        <a href="/bot/${name}/facts${q ? `?q=${encodeURIComponent(q)}` : ''}" style="font-size:0.7rem;padding:0.2rem 0.6rem;border-radius:10px;text-decoration:none;background:${!topicFilter ? 'var(--mc-accent)' : 'var(--mc-surface)'};color:${!topicFilter ? '#fff' : 'var(--mc-text-dim)'};border:1px solid ${!topicFilter ? 'var(--mc-accent)' : 'var(--mc-border)'}">${t('facts.allTopics')} (${total})</a>
        ${topics.map(tp => {
          const isActive = tp.topic === topicFilter
          const bg = isActive ? topicColor(tp.topic) : 'var(--mc-surface)'
          const border = isActive ? topicColor(tp.topic) : 'var(--mc-border)'
          return html`<a href="/bot/${name}/facts?topic=${tp.topic}${q ? `&q=${encodeURIComponent(q)}` : ''}" style="font-size:0.7rem;padding:0.2rem 0.6rem;border-radius:10px;text-decoration:none;background:${bg};color:#1a1a2e;border:1px solid ${border};font-weight:${isActive ? '600' : '400'}">${tp.topic} (${tp.count})</a>`
        })}
      </div>
    ` : ''}
    <form method="GET" action="/bot/${name}/facts" class="filter-bar">
      <input type="hidden" name="topic" value="${topicFilter}">
      <label class="filter-search">
        <small>${t('facts.search')}</small>
        <input type="search" name="q" value="${q}" placeholder="${t('facts.searchPlaceholder')}">
      </label>
      <button type="submit" class="btn-sm">${icon('search', 13)} ${t('facts.searchBtn')}</button>
      <button type="button" class="btn-sm outline" hx-get="/bot/${name}/facts/recall" hx-include="closest form" hx-target="#facts-results" hx-swap="innerHTML" hx-indicator="#recall-spinner">
        ${icon('zap', 13)} ${t('facts.recallBtn')} <span id="recall-spinner" class="htmx-indicator" style="display:inline-block;width:12px;height:12px;border:2px solid var(--mc-text-dim);border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;margin-left:4px"></span>
      </button>
      ${(q || topicFilter) ? html`<a href="/bot/${name}/facts" role="button" class="btn-sm outline" style="text-decoration:none">${icon('x', 13)}</a>` : ''}
    </form>
    <div id="rebuild-section" style="margin-bottom:1rem">
      ${isRebuilding
        ? html`<div id="rebuild-progress" hx-get="/bot/${name}/facts/rebuild/status" hx-trigger="every 1s" hx-swap="innerHTML"></div>`
        : html`
          <button hx-post="/bot/${name}/facts/rebuild" hx-target="#rebuild-section" hx-swap="innerHTML"
            hx-confirm="${t('facts.rebuildConfirm')}" class="btn-sm">
            ${icon('refresh-cw', 13)} ${t('facts.rebuild')}
          </button>
        `
      }
    </div>
    <div id="facts-alerts"></div>
    <div id="facts-results">
    ${facts.length === 0
      ? html`<div class="empty-state"><div class="empty-icon">${icon('database', 32)}</div><p>${t('facts.noFacts')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:30px" class="hide-mobile"></th>
              <th style="width:80px">${t('facts.topic')}</th>
              <th>${t('facts.content')}</th>
              <th style="width:80px" class="hide-mobile">${t('facts.date')}</th>
              <th style="width:40px"></th>
            </tr></thead>
            <tbody>
              ${facts.map(f => {
                const sectorIcon = f.sector === 'preference' ? 'star' : f.sector === 'semantic' ? 'bookmark' : 'calendar'
                const sectorTitle = f.sector === 'preference' ? 'preference' : f.sector === 'semantic' ? 'fact' : 'event'
                const dateStr = new Date(f.created_at * 1000).toISOString().slice(0, 10)
                const tags = f.tags ? f.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : []
                return html`
                <tr id="fact-${f.id}">
                  <td class="hide-mobile" title="${sectorTitle}">${icon(sectorIcon, 14)}</td>
                  <td><span style="font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:10px;background:${topicColor(f.topic)};color:#1a1a2e">${f.topic}</span></td>
                  <td>
                    <div id="fact-view-${f.id}">
                      <span style="font-size:0.8rem;cursor:pointer" title="Click to edit"
                        onclick="document.getElementById('fact-view-${f.id}').style.display='none';document.getElementById('fact-edit-${f.id}').style.display='block'">
                        ${f.content}
                      </span>
                      ${tags.length > 0 ? html`
                        <div style="margin-top:0.25rem;display:flex;flex-wrap:wrap;gap:0.2rem">
                          ${tags.map((tag: string) => html`<span style="font-size:0.6rem;padding:0.1rem 0.35rem;border-radius:8px;background:var(--mc-surface);color:var(--mc-text-dim);border:1px solid var(--mc-border)">${tag}</span>`)}
                        </div>
                      ` : ''}
                    </div>
                    <form id="fact-edit-${f.id}" style="display:none" hx-put="/bot/${name}/facts/${f.id}" hx-target="#facts-alerts" hx-swap="innerHTML">
                      <textarea name="content" rows="2" style="width:100%;font-size:0.8rem;margin-bottom:0.3rem">${f.content}</textarea>
                      <input name="tags" value="${f.tags}" style="width:100%;font-size:0.7rem;padding:0.25rem 0.4rem;color:var(--mc-text-dim)" placeholder="tags (comma-separated)">
                      <div style="display:flex;gap:0.3rem;margin-top:0.3rem">
                        <button type="submit" class="btn-sm">${icon('check', 11)}</button>
                        <button type="button" class="btn-sm outline" onclick="document.getElementById('fact-edit-${f.id}').style.display='none';document.getElementById('fact-view-${f.id}').style.display=''">${icon('x', 11)}</button>
                      </div>
                    </form>
                  </td>
                  <td class="hide-mobile"><small style="color:var(--mc-text-dim)">${dateStr}</small>${f.source && f.source !== 'conversation' ? html`<br><small style="font-size:0.55rem;color:var(--mc-text-dim)" title="${f.source}">${truncate(f.source, 15)}</small>` : ''}</td>
                  <td>
                    <button hx-post="/bot/${name}/facts/${f.id}/delete" hx-target="#fact-${f.id}" hx-swap="outerHTML"
                      hx-confirm="${t('facts.deleteConfirm')}" class="danger btn-sm">${icon('trash-2', 12)}</button>
                  </td>
                </tr>
              `})}
            </tbody>
          </table>
        </div>
        ${pagination(page, totalPages, baseUrl)}
      `
    }
    </div>
  `
  return c.html(layout(`${name} ${t('facts.title')}`, content, `/bot/${name}/facts`, t, lang))
})

// Semantic recall via embeddings (same mechanism as bot's SearchMemory)
app.get('/bot/:name/facts/recall', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const q = c.req.query('q')?.trim() || ''
  const topicFilter = c.req.query('topic') || ''

  if (!q) {
    return c.html(html`<div class="alert alert-error">${t('facts.recallNoQuery')}</div>`)
  }

  try {
    const { embed, cosineSim, isReady } = await import('../../embeddings.js')

    if (!(await isReady())) {
      return c.html(html`<div class="alert alert-error">${t('facts.recallUnavailable')}</div>`)
    }

    const queryVec = await embed(q, 'query')
    if (!queryVec) {
      return c.html(html`<div class="alert alert-error">${t('facts.recallUnavailable')}</div>`)
    }

    const db = getBotDb(name)
    let rows: (FactRow & { embedding: Buffer | null })[]
    if (topicFilter) {
      rows = db.prepare('SELECT * FROM facts WHERE embedding IS NOT NULL AND topic = ?').all(topicFilter) as unknown as (FactRow & { embedding: Buffer | null })[]
    } else {
      rows = db.prepare('SELECT * FROM facts WHERE embedding IS NOT NULL').all() as unknown as (FactRow & { embedding: Buffer | null })[]
    }

    const VECTOR_THRESHOLD = 0.4
    const PREFERENCE_THRESHOLD = 0.3
    const scored: { fact: FactRow; score: number }[] = []
    for (const row of rows) {
      if (!row.embedding) continue
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
      const score = cosineSim(queryVec, vec)
      const threshold = row.sector === 'preference' ? PREFERENCE_THRESHOLD : VECTOR_THRESHOLD
      if (score > threshold) {
        scored.push({ fact: row, score })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    const results = scored.slice(0, 30)

    if (results.length === 0) {
      return c.html(html`<div class="alert alert-info">${t('facts.recallNoResults')}</div>`)
    }

    return c.html(html`
      <div style="margin-bottom:0.5rem"><small style="color:var(--mc-text-dim)">${t('facts.recallResults', { count: String(results.length) })}</small></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th style="width:30px" class="hide-mobile"></th>
            <th style="width:80px">${t('facts.topic')}</th>
            <th>${t('facts.content')}</th>
            <th style="width:50px" class="hide-mobile">Score</th>
            <th style="width:40px"></th>
          </tr></thead>
          <tbody>
            ${results.map(({ fact: f, score }) => {
              const sectorIcon = f.sector === 'preference' ? 'star' : f.sector === 'semantic' ? 'bookmark' : 'calendar'
              const sectorTitle = f.sector === 'preference' ? 'preference' : f.sector === 'semantic' ? 'fact' : 'event'
              const tags = f.tags ? f.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : []
              return html`
              <tr id="fact-${f.id}">
                <td class="hide-mobile" title="${sectorTitle}">${icon(sectorIcon, 14)}</td>
                <td><span style="font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:10px;background:${topicColor(f.topic)};color:#1a1a2e">${f.topic}</span></td>
                <td>
                  <span style="font-size:0.8rem">${f.content}</span>
                  ${tags.length > 0 ? html`
                    <div style="margin-top:0.25rem;display:flex;flex-wrap:wrap;gap:0.2rem">
                      ${tags.map((tag: string) => html`<span style="font-size:0.6rem;padding:0.1rem 0.35rem;border-radius:8px;background:var(--mc-surface);color:var(--mc-text-dim);border:1px solid var(--mc-border)">${tag}</span>`)}
                    </div>
                  ` : ''}
                </td>
                <td class="hide-mobile"><small style="color:var(--mc-text-dim)">${(score * 100).toFixed(0)}%</small></td>
                <td>
                  <button hx-post="/bot/${name}/facts/${f.id}/delete" hx-target="#fact-${f.id}" hx-swap="outerHTML"
                    hx-confirm="${t('facts.deleteConfirm')}" class="danger btn-sm">${icon('trash-2', 12)}</button>
                </td>
              </tr>
            `})}
          </tbody>
        </table>
      </div>
    `)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.html(html`<div class="alert alert-error">Recall error: ${msg}</div>`)
  }
})

app.put('/bot/:name/facts/:id', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const id = parseInt(c.req.param('id')!, 10)
  const body = await c.req.parseBody()
  const content = String(body['content'] ?? '')
  const tags = String(body['tags'] ?? '')
  if (!content) return c.html(alert('error', t('facts.contentRequired')))
  updateFactContent(name, id, content, tags)
  return c.html(alert('success', t('facts.updated', { id: String(id) })))
})

app.post('/bot/:name/facts/:id/delete', validateBot, (c) => {
  deleteFact(botName(c), parseInt(c.req.param('id')!, 10))
  return c.html(html``)
})

// --- Rebuild facts from context/ and knowledge/ files ---

interface RebuildState {
  abort: AbortController
  totalFiles: number
  currentFile: number
  currentFileName: string
  factsAdded: number
  status: 'running' | 'done' | 'stopped' | 'error'
  error?: string
}

const rebuildStates = new Map<string, RebuildState>()

function collectFiles(dir: string, result: { name: string; content: string }[], baseDir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(fullPath, result, baseDir)
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.txt')) {
      const content = readFileSync(fullPath, 'utf-8')
      if (content.trim().length > 20) {
        result.push({ name: fullPath.replace(baseDir + '/', ''), content })
      }
    }
  }
}

function countFactsInDb(botName: string): number {
  try {
    const db = getBotDb(botName)
    const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").get()
    if (!check) return 0
    return (db.prepare('SELECT COUNT(*) as cnt FROM facts').get() as unknown as { cnt: number }).cnt
  } catch { return 0 }
}

// Start rebuild
app.post('/bot/:name/facts/rebuild', validateBot, async (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)

  if (rebuildStates.has(name) && rebuildStates.get(name)!.status === 'running') {
    return c.html(html`<div id="rebuild-progress" hx-get="/bot/${name}/facts/rebuild/status" hx-trigger="every 1s" hx-swap="innerHTML"></div>`)
  }

  const botDir = getBotDir(name)
  const files: { name: string; content: string }[] = []
  for (const dir of ['context', 'knowledge']) {
    const fullDir = join(botDir, dir)
    if (!existsSync(fullDir)) continue
    collectFiles(fullDir, files, fullDir)
  }

  if (files.length === 0) {
    return c.html(html`
      <div class="alert alert-error">${t('facts.noFiles')}</div>
      <button hx-post="/bot/${name}/facts/rebuild" hx-target="#rebuild-section" hx-swap="innerHTML"
        hx-confirm="${t('facts.rebuildConfirm')}" class="btn-sm">
        ${icon('refresh-cw', 13)} ${t('facts.rebuild')}
      </button>
    `)
  }

  const abort = new AbortController()
  const state: RebuildState = {
    abort,
    totalFiles: files.length,
    currentFile: 0,
    currentFileName: '',
    factsAdded: 0,
    status: 'running',
  }
  rebuildStates.set(name, state)
  activeRebuilds.set(name, { abort })

  // Run rebuild in background
  rebuildFacts(name, botDir, files, state).finally(() => {
    activeRebuilds.delete(name)
  })

  return c.html(html`<div id="rebuild-progress" hx-get="/bot/${name}/facts/rebuild/status" hx-trigger="every 1s" hx-swap="innerHTML"></div>`)
})

// Poll rebuild status
app.get('/bot/:name/facts/rebuild/status', validateBot, (c) => {
  const t: TFunc = c.get('t')
  const name = botName(c)
  const state = rebuildStates.get(name)

  if (!state) {
    return c.html(html`
      <button hx-post="/bot/${name}/facts/rebuild" hx-target="#rebuild-section" hx-swap="innerHTML"
        hx-confirm="${t('facts.rebuildConfirm')}" class="btn-sm">
        ${icon('refresh-cw', 13)} ${t('facts.rebuild')}
      </button>
    `)
  }

  if (state.status === 'running') {
    const pct = state.totalFiles > 0 ? Math.round((state.currentFile / state.totalFiles) * 100) : 0
    return c.html(html`
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0">
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;margin-bottom:0.3rem">
            <small>${t('facts.rebuildProgress', { current: String(state.currentFile), total: String(state.totalFiles), facts: String(state.factsAdded) })}</small>
            <small>${pct}%</small>
          </div>
          <div style="background:var(--mc-border);border-radius:4px;height:6px;overflow:hidden">
            <div style="background:var(--mc-accent);height:100%;width:${pct}%;transition:width 0.3s"></div>
          </div>
          <small style="color:var(--mc-text-dim);margin-top:0.2rem;display:block">${state.currentFileName}</small>
          ${state.error ? html`<small style="color:var(--mc-danger);margin-top:0.2rem;display:block">${state.error}</small>` : ''}
        </div>
        <button hx-post="/bot/${name}/facts/rebuild/stop" hx-target="#rebuild-section" hx-swap="innerHTML" class="btn-sm danger">
          ${icon('square', 13)} ${t('facts.stop')}
        </button>
      </div>
    `)
  }

  // Done / stopped / error
  const statusMsg = state.status === 'done'
    ? t('facts.rebuildDone', { facts: String(state.factsAdded), files: String(state.totalFiles) })
    : state.status === 'stopped'
    ? t('facts.rebuildStopped', { facts: String(state.factsAdded), current: String(state.currentFile), total: String(state.totalFiles) })
    : `Error: ${state.error}`

  const alertType = state.status === 'error' ? 'error' : 'success'
  rebuildStates.delete(name)

  return c.html(html`
    <div class="alert alert-${alertType}">${statusMsg}</div>
    <button hx-post="/bot/${name}/facts/rebuild" hx-target="#rebuild-section" hx-swap="innerHTML"
      hx-confirm="${t('facts.rebuildConfirm')}" class="btn-sm">
      ${icon('refresh-cw', 13)} ${t('facts.rebuild')}
    </button>
  `)
})

// Stop rebuild
app.post('/bot/:name/facts/rebuild/stop', validateBot, (c) => {
  const name = botName(c)
  const state = rebuildStates.get(name)
  if (state) {
    state.abort.abort()
    state.status = 'stopped'
  }
  return c.html(html`<div id="rebuild-progress" hx-get="/bot/${name}/facts/rebuild/status" hx-trigger="load" hx-swap="innerHTML"></div>`)
})

// Background rebuild — uses Agent SDK query() to extract facts as JSON, inserts into DB
async function rebuildFacts(bot: string, botDir: string, files: { name: string; content: string }[], state: RebuildState): Promise<void> {
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const db = getBotDb(bot)

    // Ensure facts table exists
    try { db.prepare("SELECT 1 FROM facts LIMIT 0").run() } catch {
      state.status = 'error'
      state.error = 'Facts table not found. Start the bot first to initialize the database.'
      return
    }

    const factsBefore = countFactsInDb(bot)

    for (let i = 0; i < files.length; i++) {
      if (state.abort.signal.aborted) break

      const file = files[i]
      state.currentFile = i + 1
      state.currentFileName = file.name

      try {
        const prompt = `Extract ALL important facts from this file. Return ONLY a JSON array, no other text or explanation.

Each fact object:
{
  "content": "clean concise fact statement",
  "topic": "category (health, work, family, preferences, contacts, projects, education, business, tech, hobbies, finance)",
  "tags": "comma-separated: synonyms, translations, related terms — the MORE the better, include both Ukrainian and English",
  "sector": "semantic or episodic"
}

Rules:
- Each fact is a standalone statement, not raw text
- One fact per distinct piece of information
- Skip headers, formatting, meta — only actual facts
- sector: "semantic" for permanent facts, "episodic" for events/decisions

File: ${file.name}
---
${file.content}
---

Return ONLY the JSON array.`

        let resultText = ''
        const conversation = query({
          prompt,
          options: {
            cwd: botDir,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            abortController: state.abort,
          },
        })

        for await (const event of conversation) {
          if (state.abort.signal.aborted) break
          if (event.type === 'result') {
            resultText = event.subtype === 'success' ? event.result : ''
            break  // result received, stop consuming events
          }
        }

        if (!resultText || state.abort.signal.aborted) continue

        // Extract JSON array from response
        const jsonMatch = resultText.match(/\[[\s\S]*\]/)
        if (!jsonMatch) {
          console.error(`[rebuild-facts] No JSON in response for ${file.name}`)
          continue
        }

        const facts = JSON.parse(jsonMatch[0]) as { content: string; topic: string; tags: string; sector: string }[]
        if (!Array.isArray(facts) || facts.length === 0) continue

        // Insert into DB
        const now = Math.floor(Date.now() / 1000)
        const stmt = db.prepare(
          'INSERT INTO facts (chat_id, topic, content, tags, source, sector, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        db.exec('BEGIN')
        try {
          for (const f of facts) {
            const sector = f.sector === 'episodic' ? 'episodic' : f.sector === 'preference' ? 'preference' : 'semantic'
            stmt.run('admin', f.topic || 'general', f.content, f.tags || '', `rebuild:${file.name}`, sector, now, now)
          }
          db.exec('COMMIT')
          // Rebuild FTS to stay in sync
          try { db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')") } catch { /* ignore */ }
        } catch (dbErr) {
          db.exec('ROLLBACK')
          console.error(`[rebuild-facts] DB error for ${file.name}:`, dbErr)
        }

        state.factsAdded = countFactsInDb(bot) - factsBefore
      } catch (err) {
        if (state.abort.signal.aborted) break
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[rebuild-facts] Error processing ${file.name}:`, errMsg)
        state.error = `${file.name}: ${errMsg}`
      }
    }

    if (!state.abort.signal.aborted) {
      state.status = 'done'
    }
  } catch (err) {
    console.error('[rebuild-facts] Fatal error:', err instanceof Error ? err.message : err)
    state.status = 'error'
    state.error = err instanceof Error ? err.message : String(err)
  }
}

export default app
