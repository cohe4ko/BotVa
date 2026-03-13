import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { getBotDir, getProjectRoot } from '../db-multi.js'
import { readEnv } from '../env-parser.js'
import { buildMcpServers } from '../../mcp-config.js'
import { isManager } from '../../team.js'
import { getBuiltinToolDefs } from '../../builtin-tools.js'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TFunc, Lang, I18nEnv } from '../i18n.js'

const app = new Hono<I18nEnv>()

// --- Source color mapping ---

const SOURCE_COLORS: Record<string, { bg: string; color: string; icon: string }> = {
  sdk:       { bg: 'var(--mc-blue-light)', color: 'var(--mc-blue)', icon: 'cpu' },
  builtin:   { bg: 'var(--mc-green-light)', color: 'var(--mc-green)', icon: 'box' },
  manager:   { bg: 'var(--mc-purple-light)', color: 'var(--mc-purple)', icon: 'users' },
  colleague: { bg: 'var(--mc-purple-light)', color: 'var(--mc-purple)', icon: 'users' },
}

function getSourceStyle(source: string): { bg: string; color: string; icon: string } {
  const key = source.toLowerCase()
  if (SOURCE_COLORS[key]) return SOURCE_COLORS[key]
  // MCP servers get orange
  return { bg: 'var(--mc-orange-light)', color: 'var(--mc-orange)', icon: 'plug' }
}

// --- Prompts ---

const ECHO_PROMPT = `You are running in diagnostic mode. Your task is to list EVERYTHING available to you in detail.

Output the following sections:

## Tools
List ALL tools available to you. For each tool, write:
- Tool name
- Brief description (one sentence)
- Which MCP server or source it belongs to (e.g. "builtin", "sdk", the MCP server name)

## MCP Servers
List all MCP servers you can see connected, with their names.

## System Instructions
Summarize the key points from your system instructions (CLAUDE.md and any other instructions you received).

## Role & Personality
Describe your configured role and personality.

## Knowledge
List any knowledge files, context documents, or other data you have access to.

Be exhaustive and precise. Do NOT call any tools — just describe what you see in your context.`

const ANALYSIS_PROMPT = `Parse the agent context echo below into a JSON structure. Return ONLY valid JSON, no markdown fences, no explanation.

Rules:
- For each tool, assign a "category" based on its function: "filesystem" (read/write/edit files), "search" (grep, glob, find), "execution" (bash, shell), "web" (fetch, search), "media" (image, voice, video, photo), "data" (database, CRM, analytics), "communication" (messaging, email, team chat), "automation" (browser, UI control), "system" (backup, gallery, publishing), "other".
- For each tool, assign "importance": "high" (core functionality, frequently used), "medium" (useful but situational), "low" (rarely used or niche).
- Group tools by their "source" field.

The JSON must have this exact structure:
{
  "tools": [{"name": "ToolName", "description": "brief description", "source": "server-name or builtin or sdk", "category": "filesystem|search|execution|web|media|data|communication|automation|system|other", "importance": "high|medium|low"}],
  "mcpServers": ["server1", "server2"],
  "systemInstructions": "summary of system instructions / CLAUDE.md (2-4 sentences)",
  "role": "bot role and personality description (1-2 sentences)",
  "knowledge": ["file1.md", "file2.md"],
  "model": "model name if mentioned, otherwise null",
  "stats": {
    "totalTools": 0,
    "toolsBySource": {"sdk": 0, "builtin": 0, "server-name": 0},
    "toolsByCategory": {"filesystem": 0, "search": 0, "execution": 0, "web": 0, "media": 0, "data": 0, "communication": 0, "automation": 0, "system": 0, "other": 0},
    "toolsByImportance": {"high": 0, "medium": 0, "low": 0}
  }
}

Agent context echo:
`

// --- Types ---

interface ToolInfo {
  name: string
  description: string
  source: string
  category: string
  importance: string
}

interface AnalysisResult {
  tools: ToolInfo[]
  mcpServers: string[]
  systemInstructions: string
  role: string
  knowledge: string[]
  model: string | null
  stats: {
    totalTools: number
    toolsBySource: Record<string, number>
    toolsByCategory: Record<string, number>
    toolsByImportance: Record<string, number>
  }
}

interface DiagnosticResult {
  echoText: string
  analysis: AnalysisResult | null
  analysisRaw: string
  error?: string
}

// --- Helpers ---

async function collectQueryResult(conversation: AsyncIterable<SDKMessage>): Promise<string> {
  let result = ''
  for await (const event of conversation) {
    if (event.type === 'result') {
      result = event.subtype === 'success' ? event.result : (event.errors?.join('\n') ?? 'Error')
    }
  }
  return result
}

async function runDiagnostics(botName: string): Promise<DiagnosticResult> {
  const projectRoot = getProjectRoot()
  const botDir = getBotDir(botName)
  const botEnv = readEnv(botName)

  const mcpServers: Record<string, any> = buildMcpServers(botEnv)

  if (isManager(projectRoot, botName)) {
    mcpServers['colleague'] = {
      command: 'node',
      args: [`${projectRoot}/mcp-servers/colleague/build/index.js`],
      env: { ...botEnv, PROJECT_ROOT: projectRoot },
    }
  } else {
    mcpServers['manager'] = {
      command: 'node',
      args: [`${projectRoot}/mcp-servers/manager/build/index.js`],
      env: { ...botEnv, PROJECT_ROOT: projectRoot, BOT_NAME: botName },
    }
  }

  // Call 1: Echo
  let echoText: string
  try {
    const echoConversation = query({
      prompt: ECHO_PROMPT,
      options: {
        cwd: botDir,
        permissionMode: 'bypassPermissions',
        mcpServers,
        canUseTool: async () => ({ behavior: 'deny' as const, message: 'Diagnostic mode — tool use disabled' }),
        model: 'sonnet',
      },
    })
    echoText = await collectQueryResult(echoConversation)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { echoText: '', analysis: null, analysisRaw: '', error: `Echo failed: ${msg}` }
  }

  if (!echoText) {
    return { echoText: '', analysis: null, analysisRaw: '', error: 'Echo returned empty result' }
  }

  // Call 2: Analysis
  let analysisRaw: string
  try {
    const analysisConversation = query({
      prompt: ANALYSIS_PROMPT + echoText,
      options: {
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        model: 'haiku',
      },
    })
    analysisRaw = await collectQueryResult(analysisConversation)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { echoText, analysis: null, analysisRaw: '', error: `Analysis failed: ${msg}` }
  }

  let analysis: AnalysisResult | null = null
  try {
    let jsonStr = analysisRaw.trim()
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }
    analysis = JSON.parse(jsonStr)
  } catch {
    // fall through
  }

  return { echoText, analysis, analysisRaw }
}

// --- Category icons & labels ---

const CATEGORY_META: Record<string, { icon: string; label: string; labelUk: string }> = {
  filesystem:     { icon: 'folder', label: 'File System', labelUk: 'Файлова система' },
  search:         { icon: 'search', label: 'Search', labelUk: 'Пошук' },
  execution:      { icon: 'terminal', label: 'Execution', labelUk: 'Виконання' },
  web:            { icon: 'globe', label: 'Web', labelUk: 'Веб' },
  media:          { icon: 'image', label: 'Media', labelUk: 'Медіа' },
  data:           { icon: 'database', label: 'Data & CRM', labelUk: 'Дані та CRM' },
  communication:  { icon: 'message-circle', label: 'Communication', labelUk: 'Комунікація' },
  automation:     { icon: 'monitor', label: 'Automation', labelUk: 'Автоматизація' },
  system:         { icon: 'settings', label: 'System', labelUk: 'Системні' },
  other:          { icon: 'box', label: 'Other', labelUk: 'Інше' },
}

const IMPORTANCE_STYLE: Record<string, { bg: string; color: string; dot: string }> = {
  high:   { bg: 'var(--mc-green-light)', color: 'var(--mc-green)', dot: '#10b981' },
  medium: { bg: 'var(--mc-blue-light)', color: 'var(--mc-blue)', dot: '#3b82f6' },
  low:    { bg: 'var(--mc-surface2)', color: 'var(--mc-text-dim)', dot: '#9ca3af' },
}

// --- Render helpers ---

function renderBarChart(data: Record<string, number>, colorFn: (key: string) => string) {
  const entries = Object.entries(data).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const max = Math.max(...entries.map(([, v]) => v), 1)

  return html`
    <div style="display:flex;flex-direction:column;gap:0.35rem;margin-top:0.5rem">
      ${entries.map(([key, count]) => {
        const pct = Math.round((count / max) * 100)
        const color = colorFn(key)
        return html`
          <div style="display:flex;align-items:center;gap:0.5rem">
            <span style="width:100px;font-size:0.72rem;color:var(--mc-text-secondary);text-align:right;flex-shrink:0">${key}</span>
            <div style="flex:1;height:20px;background:var(--mc-surface2);border-radius:4px;overflow:hidden;position:relative">
              <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s"></div>
            </div>
            <span style="width:28px;font-size:0.72rem;font-weight:600;color:var(--mc-text);font-variant-numeric:tabular-nums">${count}</span>
          </div>
        `
      })}
    </div>
  `
}

function renderToolsGrouped(tools: ToolInfo[], lang: Lang) {
  // Group by source
  const bySource: Record<string, ToolInfo[]> = {}
  for (const t of tools) {
    const src = t.source || 'unknown'
    if (!bySource[src]) bySource[src] = []
    bySource[src].push(t)
  }

  // Sort sources: sdk first, then builtin, then alphabetically
  const sourceOrder = ['sdk', 'builtin']
  const sortedSources = Object.keys(bySource).sort((a, b) => {
    const ai = sourceOrder.indexOf(a.toLowerCase())
    const bi = sourceOrder.indexOf(b.toLowerCase())
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.localeCompare(b)
  })

  return html`
    ${sortedSources.map(source => {
      const sourceTools = bySource[source]
      const style = getSourceStyle(source)
      // Sort tools within source: high importance first
      const sorted = [...sourceTools].sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 }
        return (order[a.importance as keyof typeof order] ?? 2) - (order[b.importance as keyof typeof order] ?? 2)
      })

      return html`
        <div style="margin-bottom:1rem">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem">
            <span style="display:inline-flex;align-items:center;gap:0.3rem;padding:0.2rem 0.6rem;border-radius:5px;background:${style.bg};color:${style.color};font-size:0.75rem;font-weight:600">
              ${icon(style.icon, 12)} ${source}
            </span>
            <span style="font-size:0.72rem;color:var(--mc-text-dim)">${sourceTools.length} tools</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th style="width:30px"></th>
                <th>${lang === 'uk' ? 'Інструмент' : 'Tool'}</th>
                <th>${lang === 'uk' ? 'Опис' : 'Description'}</th>
                <th style="width:100px">${lang === 'uk' ? 'Категорія' : 'Category'}</th>
                <th style="width:60px"></th>
              </tr></thead>
              <tbody>
                ${sorted.map(tool => {
                  const catMeta = CATEGORY_META[tool.category] ?? CATEGORY_META.other
                  const impStyle = IMPORTANCE_STYLE[tool.importance] ?? IMPORTANCE_STYLE.low
                  return html`
                    <tr>
                      <td style="text-align:center">
                        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${impStyle.dot}" title="${tool.importance}"></span>
                      </td>
                      <td><code style="font-size:0.78rem">${tool.name}</code></td>
                      <td style="font-size:0.78rem;color:var(--mc-text-secondary)">${tool.description}</td>
                      <td>
                        <span style="display:inline-flex;align-items:center;gap:0.2rem;font-size:0.68rem;color:var(--mc-text-dim)">
                          ${icon(catMeta.icon, 10)} ${lang === 'uk' ? catMeta.labelUk : catMeta.label}
                        </span>
                      </td>
                      <td>
                        <span style="font-size:0.65rem;padding:0.1rem 0.35rem;border-radius:3px;background:${impStyle.bg};color:${impStyle.color};font-weight:500">${tool.importance}</span>
                      </td>
                    </tr>
                  `
                })}
              </tbody>
            </table>
          </div>
        </div>
      `
    })}
  `
}

// --- Routes ---

app.get('/bot/:name/diagnostics', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = c.req.param('name')

  const builtinTools = getBuiltinToolDefs()
  const enabledBuiltin = builtinTools.filter(bt => bt.enabled && bt.available)

  const content = html`
    ${botNav(name, 'diagnostics', t)}
    <h2>${icon('radar')} ${t('diag.title')}</h2>

    <p style="color:var(--mc-text-secondary);font-size:0.85rem;margin-bottom:1rem">
      ${t('diag.desc')}
    </p>

    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1.5rem">
      <button
        hx-post="/bot/${name}/diagnostics/run"
        hx-target="#diagnostics-results"
        hx-swap="innerHTML"
        hx-indicator="#diag-spinner"
        class="btn-sm"
        style="background:var(--mc-accent);color:#fff;border-color:var(--mc-accent)"
      >${icon('radar', 13)} ${t('diag.run')}</button>
      <span id="diag-spinner" class="htmx-indicator" style="font-size:0.85rem;color:var(--mc-text-dim)">
        ${icon('loader', 13)} ${t('diag.running')}
      </span>
    </div>

    ${enabledBuiltin.length > 0 ? html`
      <details style="margin-bottom:1rem">
        <summary style="cursor:pointer;font-size:0.82rem;color:var(--mc-text-secondary);font-weight:500">
          ${icon('box', 13)} ${t('diag.builtinNote')} (${enabledBuiltin.length})
        </summary>
        <div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.5rem">
          ${enabledBuiltin.map(tool => html`
            <span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.2rem 0.5rem;background:var(--mc-green-light);color:var(--mc-green);border-radius:4px;font-size:0.72rem;font-weight:500">
              ${icon(tool.icon, 10)} ${tool.name}
            </span>
          `)}
        </div>
      </details>
    ` : ''}

    <div id="diagnostics-results"></div>
  `

  return c.html(layout(t('diag.title'), content, `/bot/${name}/diagnostics`, t, lang))
})

app.post('/bot/:name/diagnostics/run', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = c.req.param('name')

  const result = await runDiagnostics(name)

  if (result.error) {
    return c.html(html`
      <div class="alert alert-error" style="margin-top:1rem">
        ${icon('alert-circle', 14)} ${result.error}
      </div>
      ${result.echoText ? html`
        <details style="margin-top:1rem">
          <summary style="cursor:pointer;font-weight:600">${t('diag.echo')}</summary>
          <pre style="white-space:pre-wrap;font-size:0.78rem;margin-top:0.5rem;padding:1rem;background:var(--mc-bg-alt,var(--mc-surface2));border-radius:6px;max-height:500px;overflow:auto">${result.echoText}</pre>
        </details>
      ` : ''}
    `)
  }

  const a = result.analysis

  if (!a) {
    return c.html(html`
      <div class="alert alert-warning" style="margin-top:1rem">
        ${icon('alert-triangle', 14)} ${t('diag.jsonParseFailed')}
      </div>
      <pre style="white-space:pre-wrap;font-size:0.78rem;margin-top:0.5rem;padding:1rem;background:var(--mc-surface2);border-radius:6px;max-height:400px;overflow:auto">${result.analysisRaw}</pre>
      <details style="margin-top:1rem">
        <summary style="cursor:pointer;font-size:0.85rem;color:var(--mc-text-dim)">${t('diag.rawEcho')}</summary>
        <pre style="white-space:pre-wrap;font-size:0.78rem;margin-top:0.5rem;padding:1rem;background:var(--mc-surface2);border-radius:6px;max-height:500px;overflow:auto">${result.echoText}</pre>
      </details>
    `)
  }

  const stats = a.stats ?? {
    totalTools: a.tools?.length ?? 0,
    toolsBySource: {},
    toolsByCategory: {},
    toolsByImportance: {},
  }

  // Category bar color
  const catColors: Record<string, string> = {
    filesystem: '#3b82f6', search: '#8b5cf6', execution: '#f97316', web: '#06b6d4',
    media: '#ec4899', data: '#10b981', communication: '#6366f1', automation: '#f59e0b',
    system: '#64748b', other: '#9ca3af',
  }

  return c.html(html`
    <!-- Stats overview -->
    <div class="stats-grid" style="margin-top:1rem">
      <div class="stat-card">
        <div class="stat-label">${icon('wrench', 12)} ${lang === 'uk' ? 'Всього інструментів' : 'Total Tools'}</div>
        <div class="stat-number">${stats.totalTools}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('plug', 12)} ${t('diag.mcpServers')}</div>
        <div class="stat-number">${a.mcpServers?.length ?? 0}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('book-open', 12)} ${t('diag.knowledge')}</div>
        <div class="stat-number">${a.knowledge?.length ?? 0}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${icon('star', 12)} ${lang === 'uk' ? 'Ключових' : 'High priority'}</div>
        <div class="stat-number" style="color:var(--mc-green)">${stats.toolsByImportance?.high ?? 0}</div>
      </div>
    </div>

    <!-- Charts row -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem">
      <div class="table-wrap" style="padding:0.85rem">
        <div style="font-size:0.72rem;font-weight:600;color:var(--mc-text-dim);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.25rem">
          ${icon('layers', 12)} ${lang === 'uk' ? 'По джерелу' : 'By Source'}
        </div>
        ${renderBarChart(stats.toolsBySource ?? {}, (key) => {
          const s = getSourceStyle(key)
          return s.color
        })}
      </div>
      <div class="table-wrap" style="padding:0.85rem">
        <div style="font-size:0.72rem;font-weight:600;color:var(--mc-text-dim);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.25rem">
          ${icon('grid', 12)} ${lang === 'uk' ? 'По категорії' : 'By Category'}
        </div>
        ${renderBarChart(stats.toolsByCategory ?? {}, (key) => catColors[key] ?? '#9ca3af')}
      </div>
    </div>

    <!-- Importance legend -->
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem;font-size:0.72rem;color:var(--mc-text-dim)">
      <span style="font-weight:500">${lang === 'uk' ? 'Пріоритет:' : 'Importance:'}</span>
      ${Object.entries(IMPORTANCE_STYLE).map(([key, style]) => html`
        <span style="display:inline-flex;align-items:center;gap:0.25rem">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${style.dot}"></span>
          ${key}
        </span>
      `)}
    </div>

    <!-- Tools grouped by source -->
    <h3>${icon('wrench')} ${t('diag.tools')} (${a.tools?.length ?? 0})</h3>
    ${a.tools && a.tools.length > 0
      ? renderToolsGrouped(a.tools, lang)
      : html`<p style="color:var(--mc-text-dim)">${t('diag.noResult')}</p>`
    }

    <!-- MCP Servers -->
    ${a.mcpServers && a.mcpServers.length > 0 ? html`
      <h3>${icon('plug')} ${t('diag.mcpServers')} (${a.mcpServers.length})</h3>
      <div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:1rem">
        ${a.mcpServers.map((s: string) => {
          const style = getSourceStyle(s)
          return html`
            <span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.25rem 0.6rem;border-radius:5px;background:${style.bg};color:${style.color};font-size:0.78rem;font-weight:600">
              ${icon(style.icon, 12)} ${s}
            </span>
          `
        })}
      </div>
    ` : ''}

    <!-- Role & Instructions -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem">
      ${a.role ? html`
        <div class="table-wrap" style="padding:0.85rem">
          <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.4rem">
            ${icon('user', 14)}
            <span style="font-size:0.72rem;font-weight:600;color:var(--mc-text-dim);text-transform:uppercase;letter-spacing:0.04em">${t('diag.role')}</span>
          </div>
          <p style="font-size:0.82rem;color:var(--mc-text-secondary);margin:0;line-height:1.5">${a.role}</p>
        </div>
      ` : ''}
      ${a.systemInstructions ? html`
        <div class="table-wrap" style="padding:0.85rem">
          <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.4rem">
            ${icon('file-text', 14)}
            <span style="font-size:0.72rem;font-weight:600;color:var(--mc-text-dim);text-transform:uppercase;letter-spacing:0.04em">${t('diag.instructions')}</span>
          </div>
          <p style="font-size:0.82rem;color:var(--mc-text-secondary);margin:0;line-height:1.5">${a.systemInstructions}</p>
        </div>
      ` : ''}
    </div>

    <!-- Knowledge -->
    ${a.knowledge && a.knowledge.length > 0 ? html`
      <h3>${icon('book-open')} ${t('diag.knowledge')} (${a.knowledge.length})</h3>
      <div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:1rem">
        ${a.knowledge.map((k: string) => html`
          <span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.2rem 0.5rem;background:var(--mc-surface2);border-radius:4px;font-size:0.72rem;color:var(--mc-text-secondary);font-family:'SF Mono',monospace">
            ${icon('file', 10)} ${k}
          </span>
        `)}
      </div>
    ` : ''}

    <!-- Model -->
    ${a.model ? html`
      <div style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.3rem 0.7rem;background:var(--mc-purple-light);color:var(--mc-purple);border-radius:5px;font-size:0.78rem;font-weight:600;margin-bottom:1rem">
        ${icon('cpu', 13)} ${t('diag.detectedModel')}: ${a.model}
      </div>
    ` : ''}

    <!-- Raw echo -->
    <details style="margin-top:1rem">
      <summary style="cursor:pointer;font-size:0.82rem;color:var(--mc-text-dim);font-weight:500">
        ${icon('code', 13)} ${t('diag.rawEcho')}
      </summary>
      <pre style="white-space:pre-wrap;font-size:0.75rem;margin-top:0.5rem;padding:1rem;background:var(--mc-surface2);border-radius:6px;max-height:500px;overflow:auto;line-height:1.55">${result.echoText}</pre>
    </details>
  `)
})

export default app
