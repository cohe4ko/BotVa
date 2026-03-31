import { readdirSync, readFileSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { logger } from './logger.js'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

// --- Types ---

export interface AgentProfile {
  slug: string
  name: string
  description: string
  emoji: string
  prompt: string
  tools?: string[]
}

// --- Config ---

const DEFAULT_AGENTS_DIR = join(homedir(), '.claude', 'agents')
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 min

// --- Cache ---

let cachedProfiles: AgentProfile[] | null = null
let cacheTimestamp = 0
let cachedDir = ''

// --- Frontmatter parser ---

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      let val = line.slice(idx + 1).trim()
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      meta[key] = val
    }
  }
  return { meta, body: match[2] }
}

function parseProfile(filePath: string): AgentProfile | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const { meta, body } = parseFrontmatter(content)

    if (!meta.name || !meta.description) return null

    const tools = meta.tools
      ? meta.tools.split(',').map(t => t.trim()).filter(Boolean)
      : undefined

    return {
      slug: basename(filePath, '.md'),
      name: meta.name,
      description: meta.description,
      emoji: meta.emoji || '🤖',
      prompt: body.trim(),
      tools: tools?.length ? tools : undefined,
    }
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse agent profile')
    return null
  }
}

// --- Public API ---

export function loadCatalog(agentsDir?: string): AgentProfile[] {
  const dir = agentsDir || process.env.AGENTS_DIR || DEFAULT_AGENTS_DIR
  const now = Date.now()

  if (cachedProfiles && cachedDir === dir && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedProfiles
  }

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'))
    const profiles: AgentProfile[] = []

    for (const file of files) {
      const profile = parseProfile(join(dir, file))
      if (profile) profiles.push(profile)
    }

    cachedProfiles = profiles
    cachedDir = dir
    cacheTimestamp = now
    logger.info({ count: profiles.length, dir }, 'Agent catalog loaded')

    return profiles
  } catch (err) {
    logger.warn({ err, dir }, 'Failed to load agent catalog')
    return cachedProfiles ?? []
  }
}

export function getProfile(slug: string, agentsDir?: string): AgentProfile | undefined {
  return loadCatalog(agentsDir).find(p => p.slug === slug)
}

export function clearCatalogCache(): void {
  cachedProfiles = null
  cacheTimestamp = 0
}

// --- Agent Definition builder ---

export function buildAgentDefinitions(
  profiles: AgentProfile[],
  lang: string
): Record<string, AgentDefinition> {
  const langDirective = lang === 'en'
    ? 'Always respond in English.'
    : 'Завжди відповідай українською мовою.'

  const telegramRules = `Format for Telegram chat:
- Use Markdown: **bold**, _italic_, \`code\`
- Keep messages under 4000 chars, split if longer
- Be concise — this is a chat, not a document`

  const result: Record<string, AgentDefinition> = {}
  for (const p of profiles) {
    result[p.slug] = {
      description: `${p.emoji} ${p.name} — ${p.description}`,
      prompt: `${langDirective}\n${telegramRules}\n\n${p.prompt}`,
      ...(p.tools?.length ? { tools: p.tools } : {}),
      maxTurns: 15,
    }
  }
  return result
}
