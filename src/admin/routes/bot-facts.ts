import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { alert, formatTs, truncate, pagination } from '../views/components.js'
import { getFacts, countFacts, getFactTopics, updateFactContent, deleteFact, getBotDir, getBotDb } from '../db-multi.js'
import { validateBot, botName } from '../bot-middleware.js'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const app = new Hono<I18nEnv>()
const PAGE_SIZE = 30

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
    <form method="GET" action="/bot/${name}/facts" class="filter-bar">
      <label class="filter-search">
        <small>${t('facts.search')}</small>
        <input type="search" name="q" value="${q}" placeholder="${t('facts.searchPlaceholder')}">
      </label>
      ${topics.length > 0 ? html`
        <label>
          <small>${t('facts.topic')}</small>
          <select name="topic" style="min-width:120px">
            <option value="">${t('facts.allTopics')}</option>
            ${topics.map(tp => html`<option value="${tp.topic}" ${tp.topic === topicFilter ? 'selected' : ''}>${tp.topic} (${tp.count})</option>`)}
          </select>
        </label>
      ` : ''}
      <button type="submit" class="btn-sm">${icon('search', 13)} ${t('facts.searchBtn')}</button>
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
    ${facts.length === 0
      ? html`<div class="empty-state"><div class="empty-icon">${icon('database', 32)}</div><p>${t('facts.noFacts')}</p></div>`
      : html`
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:40px">${t('facts.id')}</th>
              <th style="width:90px">${t('facts.topic')}</th>
              <th style="width:70px">${t('facts.sector')}</th>
              <th>${t('facts.content')}</th>
              <th style="width:160px">${t('facts.tags')}</th>
              <th style="width:100px">${t('facts.date')}</th>
              <th style="width:70px"></th>
            </tr></thead>
            <tbody>
              ${facts.map(f => html`
                <tr id="fact-${f.id}">
                  <td><small>${f.id}</small></td>
                  <td><span class="badge badge-optional">${f.topic}</span></td>
                  <td><small>${f.sector}</small></td>
                  <td>
                    <div class="editable-cell" id="fact-content-${f.id}">
                      <span class="editable-text" title="${f.content}" style="font-size:0.78rem;cursor:pointer"
                        onclick="this.style.display='none';this.nextElementSibling.style.display='block'">${truncate(f.content, 80)}</span>
                      <form style="display:none" hx-put="/bot/${name}/facts/${f.id}" hx-target="#facts-alerts" hx-swap="innerHTML">
                        <textarea name="content" rows="2" style="width:100%;font-size:0.78rem">${f.content}</textarea>
                        <input type="hidden" name="tags" value="${f.tags}">
                        <div style="display:flex;gap:0.3rem;margin-top:0.3rem">
                          <button type="submit" class="btn-sm">${icon('check', 11)}</button>
                          <button type="button" class="btn-sm outline" onclick="this.closest('form').style.display='none';this.closest('form').previousElementSibling.style.display=''">${icon('x', 11)}</button>
                        </div>
                      </form>
                    </div>
                  </td>
                  <td><small title="${f.tags}" style="color:var(--mc-text-dim)">${truncate(f.tags, 30)}</small></td>
                  <td class="ts-cell">${formatTs(f.created_at)}</td>
                  <td>
                    <button hx-post="/bot/${name}/facts/${f.id}/delete" hx-target="#fact-${f.id}" hx-swap="outerHTML"
                      hx-confirm="${t('facts.deleteConfirm')}" class="danger btn-sm">${icon('trash-2', 12)}</button>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
        ${pagination(page, totalPages, baseUrl)}
      `
    }
  `
  return c.html(layout(`${name} ${t('facts.title')}`, content, `/bot/${name}/facts`, t, lang))
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
      if (entry.name === 'memories') continue
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

// Background rebuild process — uses Claude API directly to extract facts as JSON, then inserts into DB
async function rebuildFacts(bot: string, botDir: string, files: { name: string; content: string }[], state: RebuildState): Promise<void> {
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic()
    const db = getBotDb(bot)

    // Ensure facts table exists
    try { db.prepare("SELECT 1 FROM facts LIMIT 0").run() } catch {
      // Table doesn't exist yet — skip, it will be created on bot start
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
        const response = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: `Extract ALL important facts from this file. Return ONLY a JSON array, no other text.

Each fact object:
{
  "content": "clean concise fact statement",
  "topic": "category (health, work, family, preferences, contacts, projects, education, business, tech, hobbies, finance)",
  "tags": "comma-separated: synonyms, translations, related terms, alternative spellings — the MORE the better",
  "sector": "semantic (permanent fact) or episodic (event/decision)"
}

Rules:
- Each fact is a standalone statement, not raw text
- Tags should include Ukrainian AND English terms, synonyms, related words
- One fact per distinct piece of information
- Skip headers, formatting, and meta-information — only actual facts

File: ${file.name}
---
${file.content}
---

Return ONLY the JSON array.`
          }],
        }, { signal: state.abort.signal })

        // Parse JSON from response
        const text = response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')

        // Extract JSON array from response (may be wrapped in ```json...```)
        const jsonMatch = text.match(/\[[\s\S]*\]/)
        if (!jsonMatch) continue

        const facts = JSON.parse(jsonMatch[0]) as { content: string; topic: string; tags: string; sector: string }[]
        if (!Array.isArray(facts) || facts.length === 0) continue

        // Insert into DB
        const now = Math.floor(Date.now() / 1000)
        const stmt = db.prepare(
          'INSERT INTO facts (chat_id, topic, content, tags, sector, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        db.exec('BEGIN')
        try {
          for (const f of facts) {
            const sector = f.sector === 'episodic' ? 'episodic' : 'semantic'
            stmt.run('admin', f.topic || 'general', f.content, f.tags || '', sector, now, now)
          }
          db.exec('COMMIT')
        } catch {
          db.exec('ROLLBACK')
        }
      } catch (err) {
        if (state.abort.signal.aborted) break
        // Continue with next file on error
      }

      state.factsAdded = countFactsInDb(bot) - factsBefore
    }

    if (!state.abort.signal.aborted) {
      state.status = 'done'
    }
  } catch (err) {
    state.status = 'error'
    state.error = err instanceof Error ? err.message : String(err)
  }
}

export default app
