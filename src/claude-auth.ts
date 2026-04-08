import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'

// This module used to run its own OAuth refresh loop (POST to
// https://console.anthropic.com/v1/oauth/token on a 30-min interval). It
// was removed: the loop added no value for users who authenticate via
// `claude login` (the CLI itself handles refresh) and it flooded logs with
// "Claude token refresh failed: No refresh token found" on every tick for
// setups that don't have a refresh token in ~/.claude/.credentials.json.
//
// What stayed: read-only `getAuthStatus()` used by the `/usage` command and
// the admin dashboard to show current login status (source of truth is
// `claude auth status` CLI).

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
