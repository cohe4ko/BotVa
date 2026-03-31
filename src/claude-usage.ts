import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { logger } from './logger.js'

export interface ClaudeUsageData {
  fiveHourPct: number
  sevenDayPct: number
  fiveHourReset: Date | null
  sevenDayReset: Date | null
  fiveHourStatus: string
  sevenDayStatus: string
}

function readAccessToken(): string | null {
  // 1. Try credentials file (most reliable)
  const paths = [
    join(homedir(), '.claude', '.credentials.json'),
    join(homedir(), '.claude', 'credentials.json'),
  ]
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const creds = JSON.parse(readFileSync(p, 'utf-8'))
      const token = creds?.claudeAiOauth?.accessToken
      if (token) return token
    } catch {}
  }

  // 2. Try keychain
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w',
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
    const creds = JSON.parse(raw)
    return creds?.claudeAiOauth?.accessToken ?? null
  } catch {}

  return null
}

export async function fetchClaudeUsage(): Promise<ClaudeUsageData | null> {
  const token = readAccessToken()
  if (!token) return null

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.88',
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    })

    const h = (name: string) => {
      const v = res.headers.get(name)
      return v ? parseFloat(v) : null
    }

    const fiveUtil = h('anthropic-ratelimit-unified-5h-utilization')
    const sevenUtil = h('anthropic-ratelimit-unified-7d-utilization')
    const fiveReset = h('anthropic-ratelimit-unified-5h-reset')
    const sevenReset = h('anthropic-ratelimit-unified-7d-reset')
    const fiveStatus = res.headers.get('anthropic-ratelimit-unified-5h-status') ?? 'unknown'
    const sevenStatus = res.headers.get('anthropic-ratelimit-unified-7d-status') ?? 'unknown'

    if (fiveUtil === null && sevenUtil === null) {
      logger.warn('Claude usage: no rate limit headers in response')
      return null
    }

    let fiveHourPct = (fiveUtil ?? 0) * 100
    const fiveHourReset = fiveReset ? new Date(fiveReset * 1000) : null
    const sevenDayReset = sevenReset ? new Date(sevenReset * 1000) : null

    // If 5h window already expired, usage is 0
    if (fiveHourReset && fiveHourReset < new Date()) {
      fiveHourPct = 0
    }

    return {
      fiveHourPct: Math.round(fiveHourPct),
      sevenDayPct: Math.round((sevenUtil ?? 0) * 100),
      fiveHourReset,
      sevenDayReset,
      fiveHourStatus: fiveStatus,
      sevenDayStatus: sevenStatus,
    }
  } catch (err) {
    logger.error({ err }, 'Failed to fetch Claude usage')
    return null
  }
}

export function formatTimeUntil(target: Date | null): string {
  if (!target) return '?'
  const diff = target.getTime() - Date.now()
  if (diff <= 0) return 'now'

  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)

  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0 && d === 0) parts.push(`${m}m`)
  return parts.join(' ') || '<1m'
}

function usageBar(pct: number): string {
  const filled = Math.round(pct / 10)
  return '▓'.repeat(filled) + '░'.repeat(10 - filled)
}

export function formatClaudeUsage(data: ClaudeUsageData): string[] {
  const lines: string[] = []
  lines.push('📊 <b>Claude limits:</b>')
  lines.push(`  5h: ${data.fiveHourPct}% ${usageBar(data.fiveHourPct)} (reset ${formatTimeUntil(data.fiveHourReset)})`)
  lines.push(`  7d: ${data.sevenDayPct}% ${usageBar(data.sevenDayPct)} (reset ${formatTimeUntil(data.sevenDayReset)})`)
  if (data.fiveHourStatus === 'limited' || data.sevenDayStatus === 'limited') {
    lines.push('  ⚠️ Rate limited!')
  }
  return lines
}
