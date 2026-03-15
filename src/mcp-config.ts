import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { readEnvFile } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const MCP_FILE = resolve(PROJECT_ROOT, 'mcp-servers.json')

// --- Types ---

export interface McpServerConfig {
  command: string
  args: string[]
  envVars?: string[]       // env var names required (checked at runtime)
  envPassthrough?: string[] // env var names to pass to the process
  enabled: boolean          // user toggle
  persistent?: boolean      // keep subprocess alive between agent queries (for stateful servers like browsers)
}

export interface McpServerEntry {
  name: string
  command: string
  args: string[]
  enabled: boolean         // user toggle AND env vars present
  userEnabled: boolean     // user toggle only
  condition: string        // 'always' or env var names required
  persistent: boolean      // keep subprocess alive between queries
}

export interface McpServerRuntime {
  command: string
  args: string[]
  env?: Record<string, string>
}

// --- Storage ---

function readConfig(): Record<string, McpServerConfig> {
  if (!existsSync(MCP_FILE)) return {}
  try {
    return JSON.parse(readFileSync(MCP_FILE, 'utf-8'))
  } catch { return {} }
}

function writeConfig(config: Record<string, McpServerConfig>): void {
  writeFileSync(MCP_FILE, JSON.stringify(config, null, 2) + '\n')
}

/** Initialize with defaults if mcp-servers.json doesn't exist */
export function ensureMcpConfig(): void {
  if (existsSync(MCP_FILE)) return

  const defaults: Record<string, McpServerConfig> = {
    'playwright-remote': {
      command: 'npx',
      args: ['@playwright/mcp'],
      enabled: true,
      persistent: true,
    },
    'stagehand': {
      command: '/bin/sh',
      args: ['-c', `STAGEHAND_ENV=LOCAL npx stagehand-mcp-local --modelName ${readEnvFile()['STAGEHAND_MODEL'] ?? 'google/gemini-2.5-flash'}`],
      envVars: ['GOOGLE_API_KEY'],
      envPassthrough: ['GOOGLE_API_KEY'],
      enabled: true,
      persistent: true,
    },
    'bitrix24': {
      command: 'node',
      args: [`${PROJECT_ROOT}/mcp-servers/bitrix24/build/index.js`],
      envVars: ['BITRIX24_WEBHOOK_URL'],
      envPassthrough: ['BITRIX24_WEBHOOK_URL'],
      enabled: true,
    },
    'google-workspace': {
      command: 'uvx',
      args: ['workspace-mcp', '--single-user', '--tool-tier', 'core'],
      envVars: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      envPassthrough: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'USER_GOOGLE_EMAIL', 'OAUTHLIB_INSECURE_TRANSPORT'],
      enabled: true,
    },
    'home-assistant': {
      command: 'uvx',
      args: ['hass-mcp'],
      envVars: ['HA_URL', 'HA_TOKEN'],
      envPassthrough: ['HA_URL', 'HA_TOKEN'],
      enabled: true,
    },
    'meta-ads': {
      command: 'node',
      args: [`${PROJECT_ROOT}/mcp-servers/meta-ads-mcp/build/index.js`],
      envVars: ['META_ACCESS_TOKEN'],
      envPassthrough: ['META_ACCESS_TOKEN', 'META_APP_SECRET'],
      enabled: true,
    },
    'pubmed': {
      command: `${PROJECT_ROOT}/mcp-servers/pubmed/venv/bin/python`,
      args: [`${PROJECT_ROOT}/mcp-servers/pubmed/pubmed_server.py`],
      enabled: true,
    },
    'macos-control': {
      command: 'npx',
      args: ['-y', 'macos-control-mcp'],
      enabled: true,
    },
  }

  writeConfig(defaults)
}

// --- Public API ---

export function getMcpServersConfig(env: Record<string, string> = process.env as Record<string, string>): McpServerEntry[] {
  ensureMcpConfig()
  const config = readConfig()

  return Object.entries(config).map(([name, s]) => {
    const envVars = s.envVars ?? []
    const envOk = envVars.length === 0 || envVars.every(v => !!env[v])
    const condition = envVars.length === 0 ? 'always' : envVars.join(' + ')

    return {
      name,
      command: s.command,
      args: s.args,
      enabled: s.enabled && envOk,
      userEnabled: s.enabled,
      condition,
      persistent: s.persistent ?? false,
    }
  })
}

export function setServerEnabled(name: string, enabled: boolean): void {
  const config = readConfig()
  if (config[name]) {
    config[name].enabled = enabled
    writeConfig(config)
  }
}

export function isServerDisabled(name: string): boolean {
  const config = readConfig()
  return config[name] ? !config[name].enabled : false
}

export function addMcpServer(name: string, server: McpServerConfig): void {
  const config = readConfig()
  config[name] = server
  writeConfig(config)
}

export function removeMcpServer(name: string): void {
  const config = readConfig()
  delete config[name]
  writeConfig(config)
}

export function getMcpServer(name: string): McpServerConfig | null {
  const config = readConfig()
  return config[name] ?? null
}

export function updateMcpServer(name: string, server: Partial<McpServerConfig>): void {
  const config = readConfig()
  if (config[name]) {
    config[name] = { ...config[name], ...server }
    writeConfig(config)
  }
}

/** Build mcpServers object for Claude Agent SDK (only enabled servers) */
export async function buildMcpServers(env: Record<string, string> = process.env as Record<string, string>): Promise<Record<string, any>> {
  ensureMcpConfig()
  const config = readConfig()
  const servers: Record<string, any> = {}

  for (const [name, s] of Object.entries(config)) {
    if (!s.enabled) continue

    // Check env vars
    const envVars = s.envVars ?? []
    if (envVars.length > 0 && !envVars.every(v => !!env[v])) continue

    // Build env for passthrough
    let passEnv: Record<string, string> | undefined
    if (s.envPassthrough && s.envPassthrough.length > 0) {
      passEnv = {}
      for (const key of s.envPassthrough) {
        if (env[key]) passEnv[key] = env[key]
      }
    }

    // Persistent servers: in-process proxy to persistent subprocess
    if (s.persistent) {
      try {
        const { persistentMcp } = await import('./persistent-mcp.js')
        let args = [...s.args]

        // Special case: stagehand needs API key in args
        if (name === 'stagehand' && env['GOOGLE_API_KEY']) {
          const stagehandModel = readEnvFile()['STAGEHAND_MODEL'] ?? 'google/gemini-2.5-flash'
          args = ['-c', `STAGEHAND_ENV=LOCAL npx stagehand-mcp-local --modelName ${stagehandModel} --modelApiKey ${env['GOOGLE_API_KEY']}`]
        }

        servers[name] = await persistentMcp.getServer(name, s.command, args, passEnv)
      } catch (err) {
        const { logger } = await import('./logger.js')
        logger.error({ err, name }, 'Failed to start persistent MCP server, falling back to stdio')
        // Fall through to stdio below
        const entry: McpServerRuntime = { command: s.command, args: [...s.args] }
        if (passEnv) entry.env = { ...env, ...passEnv }
        servers[name] = entry
      }
      continue
    }

    // Standard stdio servers
    const entry: McpServerRuntime = { command: s.command, args: [...s.args] }

    if (passEnv) {
      entry.env = { ...env, ...passEnv }
    }

    // Special case: stagehand needs API key in args
    if (name === 'stagehand' && env['GOOGLE_API_KEY']) {
      const stagehandModel = readEnvFile()['STAGEHAND_MODEL'] ?? 'google/gemini-2.5-flash'
      entry.args = ['-c', `STAGEHAND_ENV=LOCAL npx stagehand-mcp-local --modelName ${stagehandModel} --modelApiKey ${env['GOOGLE_API_KEY']}`]
    }

    servers[name] = entry
  }

  return servers
}
