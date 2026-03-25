import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { logger } from './logger.js'

const OAUTH_URL = 'https://console.anthropic.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REFRESH_INTERVAL_MS = 30 * 60_000 // 30 min
const BUFFER_MS = 2 * 60 * 60_000       // refresh when < 2h left

let consecutiveFailures = 0
let lastError: string | null = null
let expiredNotified = false
let intervalId: ReturnType<typeof setInterval> | null = null

interface Credentials {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

function getCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

function readCredentials(): Credentials | null {
  const path = getCredentialsPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

export interface AuthStatus {
  loggedIn: boolean
  expiresInMin: number | null
  email: string | null
  subscriptionType: string | null
}

/** Check auth via `claude auth status` CLI command (source of truth) */
export function getAuthStatus(): AuthStatus {
  try {
    const raw = execSync('claude auth status 2>&1', { encoding: 'utf-8', timeout: 5000 }).trim()
    const data = JSON.parse(raw) as { loggedIn?: boolean; email?: string; subscriptionType?: string }
    if (!data.loggedIn) return { loggedIn: false, expiresInMin: null, email: null, subscriptionType: null }

    const email = data.email ?? null
    const subscriptionType = data.subscriptionType ?? null

    // CLI confirms logged in; check credentials file for expiry details
    const creds = readCredentials()
    const expiresAt = creds?.claudeAiOauth?.expiresAt
    if (expiresAt) {
      const remaining = expiresAt - Date.now()
      return { loggedIn: true, expiresInMin: Math.max(0, Math.round(remaining / 60_000)), email, subscriptionType }
    }
    return { loggedIn: true, expiresInMin: null, email, subscriptionType }
  } catch {
    return { loggedIn: false, expiresInMin: null, email: null, subscriptionType: null }
  }
}

export async function refreshToken(): Promise<{ ok: boolean; error?: string }> {
  const credPath = getCredentialsPath()
  const creds = readCredentials()
  const oauth = creds?.claudeAiOauth
  if (!oauth?.refreshToken) return { ok: false, error: 'No refresh token found' }

  try {
    const res = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLIENT_ID,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
    }

    const data = await res.json() as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }

    if (!data.access_token) return { ok: false, error: 'No access_token in response' }

    const newExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000

    // Update credentials file
    const current = readCredentials() ?? {}
    const currentOauth = current.claudeAiOauth ?? {}
    current.claudeAiOauth = {
      ...currentOauth,
      accessToken: data.access_token,
      expiresAt: newExpiresAt,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    }
    writeFileSync(credPath, JSON.stringify(current, null, 2))

    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export function getLastRefreshError(): string | null {
  return lastError
}

export function startTokenRefreshLoop(onExpired?: () => void): void {
  if (intervalId) return

  async function tick() {
    const status = getAuthStatus()

    // Token valid with plenty of time left
    if (status.loggedIn && status.expiresInMin !== null && status.expiresInMin > BUFFER_MS / 60_000) {
      logger.info(`Claude token valid, ${status.expiresInMin} min remaining`)
      consecutiveFailures = 0
      lastError = null
      expiredNotified = false
      return
    }

    // Backoff: after 7+ failures, stop trying and notify once
    if (consecutiveFailures >= 7) {
      if (!expiredNotified) {
        expiredNotified = true
        logger.error('Claude token refresh failed 7+ times, stopping auto-refresh')
        onExpired?.()
      }
      return
    }

    // Backoff: after 4-6 failures, try less frequently (every ~2h = skip 3 of 4 ticks)
    if (consecutiveFailures >= 4 && consecutiveFailures < 7) {
      // Only attempt every 4th tick (effectively ~2h)
      if (consecutiveFailures % 2 !== 0) {
        logger.info(`Claude token refresh: backing off (failure ${consecutiveFailures})`)
        consecutiveFailures++ // still count as a "tick" for backoff progression
        return
      }
    }

    // Attempt refresh
    if (!status.loggedIn) {
      logger.warn('Claude token expired, attempting refresh...')
    } else {
      logger.info(`Claude token expires in ${status.expiresInMin} min, refreshing...`)
    }

    const result = await refreshToken()

    if (result.ok) {
      const newStatus = getAuthStatus()
      logger.info(`Claude token refreshed, valid for ${newStatus.expiresInMin} min`)
      consecutiveFailures = 0
      lastError = null
      expiredNotified = false
    } else {
      consecutiveFailures++
      lastError = result.error ?? 'Unknown error'
      logger.error(`Claude token refresh failed (${consecutiveFailures}): ${lastError}`)
    }
  }

  // Run immediately on start
  tick()

  intervalId = setInterval(tick, REFRESH_INTERVAL_MS)
}

export function stopTokenRefreshLoop(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
