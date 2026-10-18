/**
 * The vault on disk: the `secrets` table and the master key in
 * store/vault.key. No config or process state here, so both the bot
 * (secrets.ts, its own store) and the admin panel (any bot's store) use it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export const VAULT_KEY_FILE = 'vault.key'

/** Names are short so they fit in Telegram callback data. */
export const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/
export const FIELD_NAME = /^[a-z0-9_-]{1,32}$/

export interface SecretMeta {
  name: string
  fields: string[]
  note: string | null
  /** Who it came from: null for the owner, else the peer bot's label. */
  source: string | null
  source_peer: number | null
  /** The TGAP share it arrived with — a revoke must name it. */
  share_id: string | null
  expires_at: number | null
  created_at: number
}

export type SecretMetaInput = Partial<Pick<SecretMeta, 'note' | 'source' | 'source_peer' | 'share_id' | 'expires_at'>>

interface Row extends Omit<SecretMeta, 'fields'> { fields: string; blob: string }

const now = () => Math.floor(Date.now() / 1000)

export function ensureVaultSchema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      fields TEXT NOT NULL,
      blob TEXT NOT NULL,
      note TEXT,
      source TEXT,
      source_peer INTEGER,
      share_id TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secret_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      private_blob TEXT NOT NULL
    );
  `)
}

const keys = new Map<string, Buffer>()

/** The master key of the store in `storeDir`, made on first use (mode 0600). */
export function vaultKey(storeDir: string): Buffer {
  const cached = keys.get(storeDir)
  if (cached) return cached
  const file = resolve(storeDir, VAULT_KEY_FILE)
  if (!existsSync(file)) {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  }
  try { chmodSync(file, 0o600) } catch { /* not ours to fix */ }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
  if (key.length !== 32) throw new Error(`${VAULT_KEY_FILE} is damaged`)
  keys.set(storeDir, key)
  return key
}

export function encryptWith(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.')
}

export function decryptWith(key: Buffer, blob: string, aad: string): string {
  const [iv, tag, ct] = blob.split('.').map(s => Buffer.from(s, 'base64'))
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

const toMeta = (r: Row): SecretMeta => ({
  name: r.name, fields: JSON.parse(r.fields), note: r.note, source: r.source, source_peer: r.source_peer,
  share_id: r.share_id, expires_at: r.expires_at, created_at: r.created_at,
})

/** Drop expired secrets. Returns how many went. */
export function dropExpiredSecrets(d: DatabaseSync): number {
  return Number(d.prepare('DELETE FROM secrets WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now()).changes)
}

export function writeSecret(d: DatabaseSync, key: Buffer, name: string, values: Record<string, string>, meta: SecretMetaInput = {}): string {
  const n = normalizeName(name)
  if (!SECRET_NAME.test(n)) throw new Error(`Bad secret name "${name}": a-z, 0-9, _ and -, up to 24 characters`)
  const fields = Object.keys(values)
  if (fields.length === 0) throw new Error('A secret needs at least one value')
  for (const f of fields) if (!FIELD_NAME.test(f)) throw new Error(`Bad field name "${f}"`)
  d.prepare(`
    INSERT OR REPLACE INTO secrets (name, fields, blob, note, source, source_peer, share_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(n, JSON.stringify(fields), encryptWith(key, JSON.stringify(values), n), meta.note ?? null, meta.source ?? null,
    meta.source_peer ?? null, meta.share_id ?? null, meta.expires_at ?? null, now())
  return n
}

export function readSecretMeta(d: DatabaseSync, name: string): SecretMeta | undefined {
  const r = d.prepare('SELECT * FROM secrets WHERE name = ?').get(normalizeName(name)) as unknown as Row | undefined
  return r ? toMeta(r) : undefined
}

export function readSecretList(d: DatabaseSync): SecretMeta[] {
  return (d.prepare('SELECT * FROM secrets ORDER BY name').all() as unknown as Row[]).map(toMeta)
}

/** Every secret's values. A row the key cannot open is skipped. */
export function readAllValues(d: DatabaseSync, key: Buffer): Map<string, Record<string, string>> {
  const m = new Map<string, Record<string, string>>()
  for (const r of d.prepare('SELECT name, blob FROM secrets').all() as unknown as Row[]) {
    try { m.set(r.name, JSON.parse(decryptWith(key, r.blob, r.name))) } catch { /* wrong key or damaged row: skip it */ }
  }
  return m
}

export function removeSecret(d: DatabaseSync, name: string): boolean {
  return Number(d.prepare('DELETE FROM secrets WHERE name = ?').run(normalizeName(name)).changes) > 0
}

/** Test hook: forget cached master keys. */
export function _resetVaultKeysForTests(): void {
  keys.clear()
}
