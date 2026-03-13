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

// --- Prompts ---

const ECHO_PROMPT = `You are running in diagnostic mode. Your task is to list EVERYTHING available to you in detail.

Output the following sections:

## Tools
List ALL tools available to you. For each tool, write:
- Tool name
- Brief description
- Which MCP server or source it belongs to (e.g. "builtin", "sdk", server name)

## MCP Servers
List all MCP servers you can see connected.

## System Instructions
Summarize the key points from your system instructions (CLAUDE.md and any other instructions).

## Role & Personality
Describe your configured role and personality.

## Knowledge
List any knowledge files, context documents, or other data you have access to.

Be exhaustive and precise. Do NOT call any tools — just describe what you see in your context.`

const ANALYSIS_PROMPT = `Parse the agent context echo below into a JSON structure. Return ONLY valid JSON, no markdown fences, no explanation.

The JSON must have this exact structure:
{
  "tools": [{"name": "ToolName", "description": "brief description", "source": "server-name or builtin or sdk"}],
  "mcpServers": ["server1", "server2"],
  "systemInstructions": "summary of system instructions and CLAUDE.md",
  "role": "bot role and personality description",
  "knowledge": ["file1.md", "file2.md"],
  "model": "model name if mentioned, otherwise null"
}

Agent context echo:
`

// --- Helpers ---

interface DiagnosticResult {
  echoText: string
  analysis: {
    tools: { name: string; description: string; source: string }[]
    mcpServers: string[]
    systemInstructions: string
    role: string
    knowledge: string[]
    model: string | null
  } | null
  analysisRaw: string
  error?: string
}

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

  // Build MCP servers with bot's env
  const mcpServers: Record<string, any> = buildMcpServers(botEnv)

  // Add inter-bot communication MCP
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

  // Call 1: Echo — agent with full context, deny all tool calls
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

  // Call 2: Analysis — parse echo into structured JSON
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

  // Parse JSON from analysis
  let analysis = null
  try {
    // Strip markdown fences if model wrapped it
    let jsonStr = analysisRaw.trim()
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }
    analysis = JSON.parse(jsonStr)
  } catch {
    // Return raw text if JSON parsing fails
  }

  return { echoText, analysis, analysisRaw }
}

// --- Routes ---

app.get('/bot/:name/diagnostics', (c) => {
  const t: TFunc = c.get('t')
  const lang: Lang = c.get('lang')
  const name = c.req.param('name')

  // Also show builtin tools info (these aren't passed via MCP in diagnostics)
  const builtinTools = getBuiltinToolDefs()
  const enabledBuiltin = builtinTools.filter(t => t.enabled && t.available)

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
      <span id="diag-spinner" class="htmx-indicator" style="font-size:0.85rem;color:var(--mc-text-dim)">${t('diag.running')}</span>
    </div>

    ${enabledBuiltin.length > 0 ? html`
      <details style="margin-bottom:1rem">
        <summary style="cursor:pointer;font-size:0.85rem;color:var(--mc-text-secondary)">${t('diag.builtinNote')} (${enabledBuiltin.length})</summary>
        <div class="table-wrap" style="margin-top:0.5rem">
          <table>
            <thead><tr><th>${t('sys.tool')}</th><th>${t('sys.toolDesc')}</th><th>Category</th></tr></thead>
            <tbody>
              ${enabledBuiltin.map(tool => html`
                <tr>
                  <td><code style="font-size:0.78rem">${tool.name}</code></td>
                  <td style="font-size:0.78rem;color:var(--mc-text-secondary)">${tool.description}</td>
                  <td style="font-size:0.78rem;color:var(--mc-text-dim)">${tool.category}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      </details>
    ` : ''}

    <div id="diagnostics-results"></div>
  `

  return c.html(layout(t('diag.title'), content, `/bot/${name}/diagnostics`, t, lang))
})

app.post('/bot/:name/diagnostics/run', async (c) => {
  const t: TFunc = c.get('t')
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
          <pre style="white-space:pre-wrap;font-size:0.78rem;margin-top:0.5rem;padding:1rem;background:var(--mc-bg-alt);border-radius:6px;max-height:500px;overflow:auto">${result.echoText}</pre>
        </details>
      ` : ''}
    `)
  }

  const a = result.analysis

  return c.html(html`
    ${a ? html`
      <h3 style="margin-top:1rem">${icon('list')} ${t('diag.tools')} (${a.tools?.length ?? 0})</h3>
      ${a.tools && a.tools.length > 0 ? html`
        <div class="table-wrap">
          <table>
            <thead><tr><th>${t('sys.tool')}</th><th>${t('sys.toolDesc')}</th><th>${t('diag.source')}</th></tr></thead>
            <tbody>
              ${a.tools.map((tool: any) => html`
                <tr>
                  <td><code style="font-size:0.78rem">${tool.name}</code></td>
                  <td style="font-size:0.78rem;color:var(--mc-text-secondary)">${tool.description}</td>
                  <td><span class="badge" style="font-size:0.68rem">${tool.source}</span></td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      ` : html`<p style="color:var(--mc-text-dim)">${t('diag.noResult')}</p>`}

      ${a.mcpServers && a.mcpServers.length > 0 ? html`
        <h3 style="margin-top:1rem">${icon('plug')} ${t('diag.mcpServers')} (${a.mcpServers.length})</h3>
        <div style="display:flex;flex-wrap:wrap;gap:0.4rem">
          ${a.mcpServers.map((s: string) => html`<span class="badge" style="font-size:0.78rem">${s}</span>`)}
        </div>
      ` : ''}

      ${a.systemInstructions ? html`
        <h3 style="margin-top:1rem">${icon('file-text')} ${t('diag.instructions')}</h3>
        <pre style="white-space:pre-wrap;font-size:0.78rem;padding:0.75rem;background:var(--mc-bg-alt);border-radius:6px;max-height:300px;overflow:auto">${a.systemInstructions}</pre>
      ` : ''}

      ${a.role ? html`
        <h3 style="margin-top:1rem">${icon('user')} ${t('diag.role')}</h3>
        <p style="font-size:0.85rem">${a.role}</p>
      ` : ''}

      ${a.knowledge && a.knowledge.length > 0 ? html`
        <h3 style="margin-top:1rem">${icon('book-open')} ${t('diag.knowledge')} (${a.knowledge.length})</h3>
        <ul style="font-size:0.85rem">
          ${a.knowledge.map((k: string) => html`<li><code>${k}</code></li>`)}
        </ul>
      ` : ''}

      ${a.model ? html`
        <p style="margin-top:1rem;font-size:0.78rem;color:var(--mc-text-dim)">${t('diag.detectedModel')}: <strong>${a.model}</strong></p>
      ` : ''}
    ` : html`
      <div class="alert alert-warning" style="margin-top:1rem">
        ${t('diag.jsonParseFailed')}
      </div>
      <pre style="white-space:pre-wrap;font-size:0.78rem;margin-top:0.5rem;padding:1rem;background:var(--mc-bg-alt);border-radius:6px;max-height:400px;overflow:auto">${result.analysisRaw}</pre>
    `}

    <details style="margin-top:1.5rem">
      <summary style="cursor:pointer;font-size:0.85rem;color:var(--mc-text-dim)">${t('diag.rawEcho')}</summary>
      <pre style="white-space:pre-wrap;font-size:0.78rem;margin-top:0.5rem;padding:1rem;background:var(--mc-bg-alt);border-radius:6px;max-height:500px;overflow:auto">${result.echoText}</pre>
    </details>
  `)
})

export default app
