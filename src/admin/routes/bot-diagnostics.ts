import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout, botNav, icon } from '../views/layout.js'
import { getBotDir, getProjectRoot, saveDiagnosticRun, getDiagnosticRuns, getDiagnosticRun, deleteDiagnosticRun } from '../db-multi.js'
import { readEnv } from '../env-parser.js'
import { getBuiltinToolDefs } from '../../builtin-tools.js'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'child_process'
import { resolve } from 'path'
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

## Skills
If you see any skills (slash commands like /commit, /review-pr, /simplify, etc.) in your instructions, list them with their names and what they do.

Be exhaustive and precise. Do NOT call any tools — just describe what you see in your context.`

function buildAnalysisPrompt(lang: Lang): string {
  const langInstruction = lang === 'uk'
    ? 'IMPORTANT: All text values in JSON (description, title, text, reason, systemInstructions, role) MUST be in Ukrainian language.'
    : 'IMPORTANT: All text values in JSON (description, title, text, reason, systemInstructions, role) MUST be in English.'

  return `Parse the agent context echo below into a JSON structure. Return ONLY valid JSON, no markdown fences, no explanation.

${langInstruction}

Rules:
- For each tool, assign a "category" based on its function: "filesystem" (read/write/edit files), "search" (grep, glob, find), "execution" (bash, shell), "web" (fetch, search), "media" (image, voice, video, photo), "data" (database, CRM, analytics), "communication" (messaging, email, team chat), "automation" (browser, UI control), "system" (backup, gallery, publishing), "other".
- For each tool, assign "importance": "high" (core functionality, frequently used), "medium" (useful but situational), "low" (rarely used or niche).
- Group tools by their "source" field.
- In "recommendations": give 3-5 actionable tips about the agent's toolset — what could be improved, what seems redundant, what's missing.
- In "canDisable": list ONLY tools/servers that CAN actually be disabled by the admin. SDK tools (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Agent, etc.) are built into the Claude platform and CANNOT be disabled — never include them. Only include: (1) builtin tools (type: "tool") like GenerateImage, TextToSpeech, PublishTelegraph, backup tools, gallery tools, telegram media tools; (2) MCP servers (type: "mcp-server") like stagehand, bitrix24, google-workspace, meta-ads, pubmed, playwright, home-assistant, macos-control, colleague, manager. Explain WHY each can be disabled.
- If you see skills (slash commands like /commit, /review-pr, etc.) in the echo, list them in "skills" with name and description.

The JSON must have this exact structure:
{
  "tools": [{"name": "ToolName", "description": "brief description", "source": "server-name or builtin or sdk", "category": "filesystem|search|execution|web|media|data|communication|automation|system|other", "importance": "high|medium|low"}],
  "mcpServers": ["server1", "server2"],
  "systemInstructions": "summary of system instructions / CLAUDE.md (2-4 sentences)",
  "role": "bot role and personality description (1-2 sentences)",
  "knowledge": ["file1.md", "file2.md"],
  "model": "model name if mentioned, otherwise null",
  "skills": [{"name": "/skill-name", "description": "what it does"}],
  "recommendations": [{"type": "optimize|warning|tip|missing", "title": "short title", "text": "detailed recommendation"}],
  "canDisable": [{"name": "tool or server name", "type": "tool|mcp-server", "reason": "why it can be disabled"}],
  "stats": {
    "totalTools": 0,
    "toolsBySource": {"sdk": 0, "builtin": 0, "server-name": 0},
    "toolsByCategory": {"filesystem": 0, "search": 0, "execution": 0, "web": 0, "media": 0, "data": 0, "communication": 0, "automation": 0, "system": 0, "other": 0},
    "toolsByImportance": {"high": 0, "medium": 0, "low": 0}
  }
}

Agent context echo:
`
}

// --- Types ---

interface ToolInfo {
  name: string
  description: string
  source: string
  category: string
  importance: string
}

interface SkillInfo {
  name: string
  description: string
}

interface Recommendation {
  type: string  // optimize | warning | tip | missing
  title: string
  text: string
}

interface DisableSuggestion {
  name: string
  type: string  // tool | mcp-server
  reason: string
}

interface AnalysisResult {
  tools: ToolInfo[]
  mcpServers: string[]
  systemInstructions: string
  role: string
  knowledge: string[]
  model: string | null
  skills: SkillInfo[]
  recommendations: Recommendation[]
  canDisable: DisableSuggestion[]
  stats: {
    totalTools: number
    toolsBySource: Record<string, number>
    toolsByCategory: Record<string, number>
    toolsByImportance: Record<string, number>
  }
}

interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUSD: number
}

interface DiagnosticResult {
  echoText: string
  analysis: AnalysisResult | null
  analysisRaw: string
  echoUsage?: UsageInfo
  analysisUsage?: UsageInfo
  error?: string
}

// --- Helpers ---

async function collectQueryResult(conversation: AsyncIterable<SDKMessage>): Promise<{ text: string; usage?: UsageInfo }> {
  let result = ''
  let usage: UsageInfo | undefined
  for await (const event of conversation) {
    if (event.type === 'result') {
      result = event.subtype === 'success' ? event.result : (event.errors?.join('\n') ?? 'Error')
      const models = Object.values(event.modelUsage ?? {})
      if (models.length > 0) {
        const totals = models.reduce(
          (acc: any, m: any) => ({
            inputTokens: acc.inputTokens + m.inputTokens,
            outputTokens: acc.outputTokens + m.outputTokens,
            cacheReadTokens: acc.cacheReadTokens + m.cacheReadInputTokens,
            cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationInputTokens,
            costUSD: acc.costUSD + m.costUSD,
          }),
          { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0 }
        )
        usage = totals
      }
    }
  }
  return { text: result, usage }
}

/** Run diagnostic.ts as a subprocess with the bot's real environment */
function runBotDiagnostic(botName: string): Promise<{ echoText: string; usage?: UsageInfo; error?: string }> {
  return new Promise((resolve_) => {
    const projectRoot = getProjectRoot()
    const botEnv = readEnv(botName)

    const child = spawn('npx', ['tsx', resolve(projectRoot, 'src', 'diagnostic.ts')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...botEnv,
        BOT_NAME: botName,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('close', (code) => {
      // Parse last line of stdout as JSON
      const lines = stdout.trim().split('\n')
      const lastLine = lines[lines.length - 1] || ''
      try {
        const result = JSON.parse(lastLine)
        resolve_({ echoText: result.echoText ?? '', usage: result.usage, error: result.error })
      } catch {
        resolve_({ echoText: '', error: `Process exited with code ${code}. stderr: ${stderr.slice(-500)}` })
      }
    })

    child.on('error', (err) => {
      resolve_({ echoText: '', error: `Failed to start: ${err.message}` })
    })
  })
}

async function runDiagnostics(botName: string, lang: Lang): Promise<DiagnosticResult> {
  // Call 1: Echo — run the real bot process in diagnostic mode
  const echoResult = await runBotDiagnostic(botName)
  const echoText = echoResult.echoText
  const echoUsage = echoResult.usage

  if (echoResult.error && !echoText) {
    return { echoText: '', analysis: null, analysisRaw: '', error: `Echo failed: ${echoResult.error}` }
  }

  if (!echoText) {
    return { echoText: '', analysis: null, analysisRaw: '', error: 'Echo returned empty result' }
  }

  // Call 2: Analysis
  let analysisRaw: string
  let analysisUsage: UsageInfo | undefined
  try {
    const analysisConversation = query({
      prompt: buildAnalysisPrompt(lang) + echoText,
      options: {
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        model: 'haiku',
      },
    })
    const analysisResult = await collectQueryResult(analysisConversation)
    analysisRaw = analysisResult.text
    analysisUsage = analysisResult.usage
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { echoText, analysis: null, analysisRaw: '', echoUsage, error: `Analysis failed: ${msg}` }
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

  return { echoText, analysis, analysisRaw, echoUsage, analysisUsage }
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

function renderToolsGrouped(tools: ToolInfo[], lang: Lang, inputTokens?: number) {
  // Group by source
  const bySource: Record<string, ToolInfo[]> = {}
  for (const t of tools) {
    const src = t.source || 'unknown'
    if (!bySource[src]) bySource[src] = []
    bySource[src].push(t)
  }

  const totalToolCount = tools.length || 1
  const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

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
      // Estimate tokens: proportional to tool count (tool definitions ~equal size in context)
      const estTokens = inputTokens ? Math.round((inputTokens * 0.75) * (sourceTools.length / totalToolCount)) : 0
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
            ${estTokens > 0 ? html`
              <span style="font-size:0.68rem;color:var(--mc-text-dim);font-variant-numeric:tabular-nums">~${fmtTok(estTokens)} tokens</span>
            ` : ''}
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
      <div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:1rem">
        <span style="font-size:0.78rem;color:var(--mc-text-dim);margin-right:0.25rem;align-self:center">${icon('box', 13)} ${lang === 'uk' ? 'Вбудовані' : 'Builtin'} (${enabledBuiltin.length}):</span>
        ${enabledBuiltin.map(tool => html`
          <span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.15rem 0.45rem;background:var(--mc-green-light);color:var(--mc-green);border-radius:4px;font-size:0.68rem;font-weight:500">
            ${icon(tool.icon, 10)} ${tool.name}
          </span>
        `)}
      </div>
    ` : ''}

    <div id="diagnostics-results"></div>

    <h3 style="margin-top:2rem">${icon('clock')} ${t('diag.history')}</h3>
    <div id="diag-history" hx-get="/bot/${name}/diagnostics/history" hx-trigger="load, refreshHistory from:body" hx-swap="innerHTML"></div>
  `

  return c.html(layout(t('diag.title'), content, `/bot/${name}/diagnostics`, t, lang))
})

app.post('/bot/:name/diagnostics/run', async (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = c.req.param('name')

  const result = await runDiagnostics(name, lang)

  if (result.error) {
    return c.html(html`
      <div class="alert alert-error" style="margin-top:1rem">
        ${icon('alert-circle', 14)} ${result.error}
      </div>
      ${result.echoText ? html`
        <details class="inline" style="margin-top:1rem">
          <summary>${t('diag.echo')}</summary>
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
      <details class="inline" style="margin-top:1rem">
        <summary>${t('diag.rawEcho')}</summary>
        <pre style="white-space:pre-wrap;font-size:0.78rem;margin-top:0.5rem;padding:1rem;background:var(--mc-surface2);border-radius:6px;max-height:500px;overflow:auto">${result.echoText}</pre>
      </details>
    `)
  }

  // Save to history
  const totalCost = (result.echoUsage?.costUSD ?? 0) + (result.analysisUsage?.costUSD ?? 0)
  saveDiagnosticRun('bot', name, JSON.stringify(result), result.echoText,
    a.stats?.totalTools ?? 0, a.role?.slice(0, 200) ?? '', totalCost)

  c.header('HX-Trigger', 'refreshHistory')
  return c.html(renderBotDiagResult(result, lang, t))
})

// --- Render bot diagnostic result ---

function renderBotDiagResult(result: DiagnosticResult, lang: Lang, t: TFunc) {
  const a = result.analysis!

  const stats = a.stats ?? {
    totalTools: a.tools?.length ?? 0,
    toolsBySource: {},
    toolsByCategory: {},
    toolsByImportance: {},
  }

  const catColors: Record<string, string> = {
    filesystem: '#3b82f6', search: '#8b5cf6', execution: '#f97316', web: '#06b6d4',
    media: '#ec4899', data: '#10b981', communication: '#6366f1', automation: '#f59e0b',
    system: '#64748b', other: '#9ca3af',
  }

  const eu = result.echoUsage
  const contextInputTokens = eu ? (eu.inputTokens + eu.cacheReadTokens + eu.cacheCreationTokens) : 0
  const totalTokens = eu ? (contextInputTokens + eu.outputTokens) : 0

  const toolsBySource = stats.toolsBySource ?? {}
  const totalToolCount = Object.values(toolsBySource).reduce((a: number, b: number) => a + b, 0) || 1
  const segmentColors: Record<string, string> = {
    sdk: '#3b82f6', builtin: '#10b981', manager: '#8b5cf6', colleague: '#8b5cf6',
  }
  const defaultMcpColor = '#f97316'

  interface Segment { label: string; tokens: number; color: string }
  const segments: Segment[] = []

  if (eu) {
    const instructionTokensEst = Math.round(contextInputTokens * 0.15)
    const knowledgeTokensEst = Math.round(contextInputTokens * 0.10 * Math.min(1, (a.knowledge?.length ?? 0) / 3))
    const toolTokensPool = contextInputTokens - instructionTokensEst - knowledgeTokensEst

    for (const [src, count] of Object.entries(toolsBySource)) {
      const pct = (count as number) / totalToolCount
      segments.push({
        label: src,
        tokens: Math.round(toolTokensPool * pct),
        color: segmentColors[src.toLowerCase()] ?? defaultMcpColor,
      })
    }
    if (instructionTokensEst > 0) {
      segments.push({ label: lang === 'uk' ? 'Інструкції' : 'Instructions', tokens: instructionTokensEst, color: '#64748b' })
    }
    if (knowledgeTokensEst > 0) {
      segments.push({ label: lang === 'uk' ? 'Знання' : 'Knowledge', tokens: knowledgeTokensEst, color: '#06b6d4' })
    }
    segments.push({ label: lang === 'uk' ? 'Відповідь' : 'Output', tokens: eu.outputTokens, color: '#a78bfa' })
  }

  const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  return html`
    <!-- Token usage & storage bar -->
    ${eu ? html`
      <div class="table-wrap" style="padding:0.85rem;margin-top:1rem;margin-bottom:1rem">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">
          <div style="display:flex;align-items:center;gap:0.4rem">
            ${icon('gauge', 14)}
            <span style="font-size:0.72rem;font-weight:600;color:var(--mc-text-dim);text-transform:uppercase;letter-spacing:0.04em">
              ${lang === 'uk' ? 'Використання контексту' : 'Context Usage'}
            </span>
          </div>
          <div style="display:flex;gap:1rem;font-size:0.72rem;color:var(--mc-text-dim)">
            <span>${lang === 'uk' ? 'Контекст' : 'Context'}: <strong style="color:var(--mc-text)">${formatTokens(contextInputTokens)}</strong></span>
            <span>${lang === 'uk' ? 'Вихід' : 'Output'}: <strong style="color:var(--mc-text)">${formatTokens(eu.outputTokens)}</strong></span>
            ${eu.cacheReadTokens > 0 ? html`<span>${lang === 'uk' ? 'З кешу' : 'Cached'}: <strong style="color:var(--mc-text)">${formatTokens(eu.cacheReadTokens)}</strong></span>` : ''}
            <span>${lang === 'uk' ? 'Всього' : 'Total'}: <strong style="color:var(--mc-text)">${formatTokens(totalTokens)}</strong></span>
            <span style="color:var(--mc-accent);font-weight:600">$${eu.costUSD.toFixed(4)}</span>
          </div>
        </div>
        <div style="height:28px;border-radius:6px;overflow:hidden;display:flex;background:var(--mc-surface2);margin-bottom:0.5rem">
          ${segments.filter(s => s.tokens > 0).map(s => {
            const pct = Math.max(1, Math.round((s.tokens / Math.max(totalTokens, 1)) * 100))
            return html`<div style="width:${pct}%;background:${s.color};min-width:3px;position:relative" title="${s.label}: ${formatTokens(s.tokens)}"></div>`
          })}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:0.6rem;font-size:0.68rem;color:var(--mc-text-secondary)">
          ${segments.filter(s => s.tokens > 0).map(s => html`
            <span style="display:inline-flex;align-items:center;gap:0.25rem">
              <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color}"></span>
              ${s.label} <strong style="color:var(--mc-text)">${formatTokens(s.tokens)}</strong>
            </span>
          `)}
        </div>
      </div>
    ` : ''}

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

    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem;font-size:0.72rem;color:var(--mc-text-dim)">
      <span style="font-weight:500">${lang === 'uk' ? 'Пріоритет:' : 'Importance:'}</span>
      ${Object.entries(IMPORTANCE_STYLE).map(([key, style]) => html`
        <span style="display:inline-flex;align-items:center;gap:0.25rem">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${style.dot}"></span>
          ${key}
        </span>
      `)}
    </div>

    <h3>${icon('wrench')} ${t('diag.tools')} (${a.tools?.length ?? 0})</h3>
    ${a.tools && a.tools.length > 0
      ? renderToolsGrouped(a.tools, lang, eu?.inputTokens)
      : html`<p style="color:var(--mc-text-dim)">${t('diag.noResult')}</p>`
    }

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

    ${a.skills && a.skills.length > 0 ? html`
      <h3>${icon('puzzle')} ${lang === 'uk' ? 'Скіли' : 'Skills'} (${a.skills.length})</h3>
      <div class="table-wrap" style="margin-bottom:1rem">
        <table>
          <thead><tr>
            <th style="width:160px">${lang === 'uk' ? 'Команда' : 'Command'}</th>
            <th>${lang === 'uk' ? 'Опис' : 'Description'}</th>
          </tr></thead>
          <tbody>
            ${a.skills.map((s: any) => html`
              <tr>
                <td><code style="font-size:0.78rem;color:var(--mc-accent)">${s.name}</code></td>
                <td style="font-size:0.78rem;color:var(--mc-text-secondary)">${s.description}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    ` : ''}

    ${a.recommendations && a.recommendations.length > 0 ? html`
      <h3>${icon('lightbulb')} ${lang === 'uk' ? 'Рекомендації' : 'Recommendations'}</h3>
      <div style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1rem">
        ${a.recommendations.map((r: any) => {
          const typeMap: Record<string, { icon: string; bg: string; color: string; border: string }> = {
            optimize: { icon: 'zap', bg: 'var(--mc-blue-light)', color: 'var(--mc-blue)', border: 'rgba(59,130,246,0.2)' },
            warning:  { icon: 'alert-triangle', bg: 'var(--mc-yellow-light)', color: 'var(--mc-yellow)', border: 'rgba(245,158,11,0.2)' },
            tip:      { icon: 'sparkles', bg: 'var(--mc-green-light)', color: 'var(--mc-green)', border: 'rgba(16,185,129,0.2)' },
            missing:  { icon: 'plus-circle', bg: 'var(--mc-purple-light)', color: 'var(--mc-purple)', border: 'rgba(139,92,246,0.2)' },
          }
          const style = typeMap[r.type] ?? typeMap.tip
          return html`
            <div style="padding:0.65rem 0.85rem;background:${style.bg};border:1px solid ${style.border};border-radius:var(--radius-sm);display:flex;gap:0.6rem;align-items:flex-start">
              <span style="color:${style.color};flex-shrink:0;margin-top:1px">${icon(style.icon, 15)}</span>
              <div>
                <div style="font-size:0.82rem;font-weight:600;color:var(--mc-text);margin-bottom:0.15rem">${r.title}</div>
                <div style="font-size:0.78rem;color:var(--mc-text-secondary);line-height:1.45">${r.text}</div>
              </div>
            </div>
          `
        })}
      </div>
    ` : ''}

    ${a.canDisable && a.canDisable.length > 0 ? html`
      <h3>${icon('toggle-left')} ${lang === 'uk' ? 'Можна вимкнути' : 'Can be disabled'}</h3>
      <div class="table-wrap" style="margin-bottom:1rem">
        <table>
          <thead><tr>
            <th>${lang === 'uk' ? 'Назва' : 'Name'}</th>
            <th style="width:90px">${lang === 'uk' ? 'Тип' : 'Type'}</th>
            <th>${lang === 'uk' ? 'Причина' : 'Reason'}</th>
          </tr></thead>
          <tbody>
            ${a.canDisable.map((d: any) => {
              const isServer = d.type === 'mcp-server'
              return html`
                <tr>
                  <td><code style="font-size:0.78rem">${d.name}</code></td>
                  <td>
                    <span style="display:inline-flex;align-items:center;gap:0.2rem;font-size:0.68rem;padding:0.1rem 0.4rem;border-radius:3px;background:${isServer ? 'var(--mc-orange-light)' : 'var(--mc-surface2)'};color:${isServer ? 'var(--mc-orange)' : 'var(--mc-text-dim)'};font-weight:500">
                      ${icon(isServer ? 'plug' : 'wrench', 10)} ${d.type}
                    </span>
                  </td>
                  <td style="font-size:0.78rem;color:var(--mc-text-secondary)">${d.reason}</td>
                </tr>
              `
            })}
          </tbody>
        </table>
      </div>
    ` : ''}

    ${a.model ? html`
      <div style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.3rem 0.7rem;background:var(--mc-purple-light);color:var(--mc-purple);border-radius:5px;font-size:0.78rem;font-weight:600;margin-bottom:1rem">
        ${icon('cpu', 13)} ${t('diag.detectedModel')}: ${a.model}
      </div>
    ` : ''}

    <details class="inline" style="margin-top:1rem">
      <summary>${icon('code', 13)} ${t('diag.rawEcho')}</summary>
      <pre style="white-space:pre-wrap;font-size:0.75rem;margin-top:0.5rem;padding:1rem;background:var(--mc-surface2);border-radius:6px;max-height:500px;overflow:auto;line-height:1.55">${result.echoText}</pre>
    </details>
  `
}

// --- History helpers ---

function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function renderBotHistoryList(name: string, lang: Lang, t: TFunc) {
  const runs = getDiagnosticRuns('bot', name)
  if (runs.length === 0) {
    return html`<p style="color:var(--mc-text-dim);font-size:0.82rem">${t('diag.noHistory')}</p>`
  }
  return html`
    <div class="table-wrap" style="margin-top:0.5rem">
      <table>
        <thead><tr>
          <th style="width:110px">${lang === 'uk' ? 'Дата' : 'Date'}</th>
          <th style="width:60px">Tools</th>
          <th>${lang === 'uk' ? 'Роль' : 'Role'}</th>
          <th style="width:70px">${lang === 'uk' ? 'Вартість' : 'Cost'}</th>
          <th style="width:120px"></th>
        </tr></thead>
        <tbody>
          ${runs.map(r => html`
            <tr>
              <td style="font-size:0.78rem;font-variant-numeric:tabular-nums">${formatDate(r.created_at)}</td>
              <td style="font-size:0.78rem;font-weight:600">${r.score ?? '—'}</td>
              <td style="font-size:0.78rem;color:var(--mc-text-secondary);max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.summary ?? ''}</td>
              <td style="font-size:0.78rem;font-variant-numeric:tabular-nums">$${(r.cost_usd ?? 0).toFixed(3)}</td>
              <td style="display:flex;gap:0.35rem">
                <button class="btn-sm" hx-get="/bot/${name}/diagnostics/view/${r.id}" hx-target="#diagnostics-results" hx-swap="innerHTML"
                  style="font-size:0.7rem;padding:0.2rem 0.45rem">${t('diag.viewRun')}</button>
                <button class="btn-sm" hx-delete="/bot/${name}/diagnostics/${r.id}" hx-target="#diag-history" hx-swap="innerHTML"
                  hx-confirm="${lang === 'uk' ? 'Видалити цей запуск?' : 'Delete this run?'}"
                  style="font-size:0.7rem;padding:0.2rem 0.45rem;color:var(--mc-red);border-color:var(--mc-red)">${t('diag.deleteRun')}</button>
              </td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `
}

// --- History routes ---

app.get('/bot/:name/diagnostics/history', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = c.req.param('name')
  return c.html(renderBotHistoryList(name, lang, t))
})

app.get('/bot/:name/diagnostics/view/:id', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const id = parseInt(c.req.param('id'))
  const run = getDiagnosticRun(id)
  if (!run) {
    return c.html(html`<div class="alert alert-error">${icon('alert-circle', 14)} Not found</div>`)
  }
  try {
    const result: DiagnosticResult = JSON.parse(run.result_json)
    if (!result.analysis) {
      return c.html(html`<div class="alert alert-warning">${icon('alert-triangle', 14)} ${t('diag.jsonParseFailed')}</div>`)
    }
    return c.html(renderBotDiagResult(result, lang, t))
  } catch {
    return c.html(html`<div class="alert alert-error">${icon('alert-circle', 14)} Failed to parse saved result</div>`)
  }
})

app.delete('/bot/:name/diagnostics/:id', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = c.req.param('name')
  const id = parseInt(c.req.param('id'))
  deleteDiagnosticRun(id)
  return c.html(renderBotHistoryList(name, lang, t))
})

export default app
