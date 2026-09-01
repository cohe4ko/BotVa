/**
 * Telegram Observer — interactive login (phone → code → 2FA).
 *
 * Runs inside whichever process drives the UI, not inside the daemon: the very
 * first login happens before a daemon exists. On success the session string is
 * written to disk and the daemon picks it up on start.
 *
 * The pending client is held in memory for the duration of the flow. A restart
 * mid-login just means starting over — the flow takes under a minute.
 */

import { TelegramClient, Api } from 'telegram'
import { computeCheck } from 'telegram/Password.js'
import { createClient, readCredentials, saveSession, hasSession, type ApiCredentials } from './client.js'

export type LoginStep = 'idle' | 'code_sent' | 'password_needed' | 'authorized'

interface PendingLogin {
  client: TelegramClient
  phone: string
  phoneCodeHash: string
  startedAt: number
}

let pending: PendingLogin | null = null
let step: LoginStep = 'idle'

/** Abandon a pending login after 10 minutes — the code will have expired anyway. */
const PENDING_TTL_MS = 10 * 60 * 1000

function expirePending(): void {
  if (pending && Date.now() - pending.startedAt > PENDING_TTL_MS) {
    void cancelLogin()
  }
}

export interface LoginState {
  step: LoginStep
  phone: string | null
  hasSession: boolean
  hasCredentials: boolean
}

export function getLoginState(): LoginState {
  expirePending()
  return {
    step: hasSession() && step === 'idle' ? 'authorized' : step,
    phone: pending?.phone ?? null,
    hasSession: hasSession(),
    hasCredentials: readCredentials() !== null,
  }
}

export async function cancelLogin(): Promise<void> {
  if (pending) {
    try { await pending.client.disconnect() } catch { /* already down */ }
    try { await pending.client.destroy() } catch { /* already down */ }
  }
  pending = null
  step = 'idle'
}

export type LoginResult =
  | { ok: true; step: LoginStep }
  | { ok: false; error: string }

/** Step 1 — request a login code for a phone number. */
export async function startLogin(phone: string): Promise<LoginResult> {
  const creds = readCredentials()
  if (!creds) return { ok: false, error: 'TELEGRAM_API_ID / TELEGRAM_API_HASH не задані' }

  const normalized = phone.trim().replace(/[^\d+]/g, '')
  if (!/^\+?\d{8,15}$/.test(normalized)) {
    return { ok: false, error: 'Невалідний номер телефону' }
  }

  await cancelLogin()

  const client = createClient(creds, '')
  try {
    await client.connect()
    const { phoneCodeHash } = await client.sendCode(creds as ApiCredentials, normalized)
    pending = { client, phone: normalized, phoneCodeHash, startedAt: Date.now() }
    step = 'code_sent'
    return { ok: true, step }
  } catch (err) {
    try { await client.disconnect() } catch { /* ignore */ }
    return { ok: false, error: errorMessage(err) }
  }
}

/** Step 2 — submit the code Telegram sent. May report that 2FA is required. */
export async function submitCode(code: string): Promise<LoginResult> {
  expirePending()
  if (!pending) return { ok: false, error: 'Немає активної спроби входу — почни з номера' }

  const clean = code.trim().replace(/\D/g, '')
  if (!clean) return { ok: false, error: 'Порожній код' }

  try {
    await pending.client.invoke(new Api.auth.SignIn({
      phoneNumber: pending.phone,
      phoneCodeHash: pending.phoneCodeHash,
      phoneCode: clean,
    }))
    return finish()
  } catch (err) {
    const msg = errorMessage(err)
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      step = 'password_needed'
      return { ok: true, step }
    }
    return { ok: false, error: msg }
  }
}

/** Step 3 — submit the 2FA password (SRP check, the password never leaves the process). */
export async function submitPassword(password: string): Promise<LoginResult> {
  expirePending()
  if (!pending) return { ok: false, error: 'Немає активної спроби входу — почни з номера' }
  if (!password) return { ok: false, error: 'Порожній пароль' }

  try {
    const pwdInfo = await pending.client.invoke(new Api.account.GetPassword())
    const check = await computeCheck(pwdInfo, password)
    await pending.client.invoke(new Api.auth.CheckPassword({ password: check }))
    return finish()
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

async function finish(): Promise<LoginResult> {
  if (!pending) return { ok: false, error: 'Стан входу втрачено' }
  const session = String(pending.client.session.save())
  saveSession(session)
  try { await pending.client.disconnect() } catch { /* ignore */ }
  pending = null
  step = 'authorized'
  return { ok: true, step }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
