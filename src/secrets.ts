/**
 * The bot's secret vault: logins, passwords, API keys the agent may use but
 * never sees.
 *
 * The owner puts a secret in with /secret (the message is deleted at once),
 * or accepts one another BotVa bot sent over TGAP. The agent knows secrets by
 * name only and writes `{{secret:name.field}}` in a tool call; a PreToolUse
 * hook puts the value in just before the tool runs, and a PostToolUse hook
 * takes it out of whatever the tool returns. The value is in neither the
 * model's context nor the session transcript.
 *
 * At rest each secret is AES-256-GCM under a per-bot master key in
 * store/vault.key. The tool guard keeps the agent away from that file. This
 * stops the secret leaking by accident (logs, memory, chat, a model provider);
 * a bot that runs arbitrary code on the same machine can still get at it, and
 * a site it logs into sees it, of course.
 *
 * The same module holds the bot's X25519 key pair for sealing secrets to
 * another bot (TGAP, see tgap/service.ts).
 */

import {
  createCipheriv, createDecipheriv, randomBytes, generateKeyPairSync, createPrivateKey, createPublicKey,
  diffieHellman, hkdfSync, type KeyObject,
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { STORE_DIR } from './config.js'
import { getDb } from './db.js'

export const VAULT_KEY_FILE = 'vault.key'

/** Names are short so they fit in Telegram callback data. */
export const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/
const FIELD_NAME = /^[a-z0-9_-]{1,32}$/
/** Values shorter than this are not redacted from tool output: too many false hits. */
const MIN_REDACT = 4
/**
 * Fields that identify rather than authenticate. They are not taken out of
 * tool output: a login like "admin" is an ordinary word, and redacting it
 * would mangle URLs and pages. The model may see these.
 */
const PUBLIC_FIELDS = new Set(['url', 'host', 'login', 'user', 'username', 'email'])

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

interface Row extends Omit<SecretMeta, 'fields'> { fields: string; blob: string }

let ready: DatabaseSync | null = null
let masterKey: Buffer | null = null
let cache: Map<string, Record<string, string>> | null = null

function db(): DatabaseSync {
  const d = getDb()
  if (ready === d) return d
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
  ready = d
  return d
}

const now = () => Math.floor(Date.now() / 1000)

function master(): Buffer {
  if (masterKey) return masterKey
  const file = resolve(STORE_DIR, VAULT_KEY_FILE)
  if (!existsSync(file)) {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  }
  try { chmodSync(file, 0o600) } catch { /* not ours to fix */ }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
  if (key.length !== 32) throw new Error(`${VAULT_KEY_FILE} is damaged`)
  masterKey = key
  return key
}

function encrypt(plain: string, aad: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', master(), iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.')
}

function decrypt(blob: string, aad: string): string {
  const [iv, tag, ct] = blob.split('.').map(s => Buffer.from(s, 'base64'))
  const d = createDecipheriv('aes-256-gcm', master(), iv)
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

const toMeta = (r: Row): SecretMeta => ({
  name: r.name, fields: JSON.parse(r.fields), note: r.note, source: r.source, source_peer: r.source_peer,
  share_id: r.share_id, expires_at: r.expires_at, created_at: r.created_at,
})

function dropExpired(): void {
  const r = db().prepare('DELETE FROM secrets WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now())
  if (Number(r.changes) > 0) cache = null
}

// ---------------------------------------------------------------- vault

export function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

export function putSecret(
  name: string,
  values: Record<string, string>,
  meta: Partial<Pick<SecretMeta, 'note' | 'source' | 'source_peer' | 'share_id' | 'expires_at'>> = {},
): void {
  const n = normalizeName(name)
  if (!SECRET_NAME.test(n)) throw new Error(`Bad secret name "${name}": a-z, 0-9, _ and -, up to 24 characters`)
  const fields = Object.keys(values)
  if (fields.length === 0) throw new Error('A secret needs at least one value')
  for (const f of fields) if (!FIELD_NAME.test(f)) throw new Error(`Bad field name "${f}"`)
  db().prepare(`
    INSERT OR REPLACE INTO secrets (name, fields, blob, note, source, source_peer, share_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(n, JSON.stringify(fields), encrypt(JSON.stringify(values), n), meta.note ?? null, meta.source ?? null,
    meta.source_peer ?? null, meta.share_id ?? null, meta.expires_at ?? null, now())
  cache = null
}

export function getSecretMeta(name: string): SecretMeta | undefined {
  dropExpired()
  const r = db().prepare('SELECT * FROM secrets WHERE name = ?').get(normalizeName(name)) as unknown as Row | undefined
  return r ? toMeta(r) : undefined
}

export function listSecrets(): SecretMeta[] {
  dropExpired()
  return (db().prepare('SELECT * FROM secrets ORDER BY name').all() as unknown as Row[]).map(toMeta)
}

export function getSecretValues(name: string): Record<string, string> | undefined {
  return allValues().get(normalizeName(name))
}

export function deleteSecret(name: string): boolean {
  const r = db().prepare('DELETE FROM secrets WHERE name = ?').run(normalizeName(name))
  cache = null
  return Number(r.changes) > 0
}

/** A name not taken yet: `name`, else `name-2`, `name-3`… */
export function freeName(name: string): string {
  const base = normalizeName(name).slice(0, 21)
  if (!getSecretMeta(base)) return base
  for (let i = 2; i < 100; i++) if (!getSecretMeta(`${base}-${i}`)) return `${base}-${i}`
  throw new Error('Too many secrets with this name')
}

/** Every secret's values, decrypted once and kept until the vault changes. */
function allValues(): Map<string, Record<string, string>> {
  dropExpired()
  if (cache) return cache
  const m = new Map<string, Record<string, string>>()
  for (const r of db().prepare('SELECT name, blob FROM secrets').all() as unknown as Row[]) {
    try { m.set(r.name, JSON.parse(decrypt(r.blob, r.name))) } catch { /* wrong key or damaged row: skip it */ }
  }
  cache = m
  return m
}

/**
 * What the owner typed: `field: value` lines, or else the whole text as one
 * value. A first line that is a URL with no field name becomes `url`.
 */
export function parseSecretInput(text: string): Record<string, string> {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const out: Record<string, string> = {}
  let structured = lines.length > 0
  for (const l of lines) {
    const m = /^([A-Za-z0-9_-]{1,32})\s*[:=]\s*(.+)$/.exec(l)
    if (m && !/^https?$/i.test(m[1])) out[m[1].toLowerCase()] = m[2].trim()
    else if (/^https?:\/\/\S+$/i.test(l) && !out.url) out.url = l
    else { structured = false; break }
  }
  if (structured && Object.keys(out).length > 0) return out
  return { value: text.trim() }
}

// ---------------------------------------------------------------- placeholders

const PLACEHOLDER = /\{\{secret:([a-z0-9][a-z0-9_-]{0,23})(?:\.([a-z0-9_-]{1,32}))?\}\}/gi

export interface Resolved {
  value: unknown
  used: string[]
  missing: string[]
}

function pickField(values: Record<string, string>, field: string | undefined): string | undefined {
  if (field) return values[field.toLowerCase()]
  const keys = Object.keys(values)
  if (keys.length === 1) return values[keys[0]]
  return values.value ?? values.password
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map(x => mapStrings(x, f))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]))
  return v
}

export function hasPlaceholder(v: unknown): boolean {
  return JSON.stringify(v ?? null).match(PLACEHOLDER) !== null
}

/** Put secret values in place of `{{secret:name.field}}` everywhere in a tool input. */
export function resolvePlaceholders(input: unknown): Resolved {
  const used = new Set<string>()
  const missing = new Set<string>()
  const vault = allValues()
  const value = mapStrings(input, s => s.replace(PLACEHOLDER, (whole, name: string, field?: string) => {
    const values = vault.get(name.toLowerCase())
    const v = values ? pickField(values, field) : undefined
    if (v === undefined) { missing.add(whole); return whole }
    used.add(field ? `${name}.${field}` : name)
    return v
  }))
  return { value, used: [...used], missing: [...missing] }
}

/** Replace every secret value in `v` with its placeholder. Returns null if nothing was found. */
export function redact(v: unknown): unknown | null {
  const pairs: Array<[string, string]> = []
  for (const [name, values] of allValues()) {
    for (const [field, value] of Object.entries(values)) {
      if (value.length >= MIN_REDACT && !PUBLIC_FIELDS.has(field)) pairs.push([value, `{{secret:${name}.${field}}}`])
    }
  }
  if (pairs.length === 0) return null
  // Longest first, so a value that contains another is replaced whole
  pairs.sort((a, b) => b[0].length - a[0].length)
  let hit = false
  const out = mapStrings(v, s => {
    let r = s
    for (const [value, ph] of pairs) if (r.includes(value)) { r = r.split(value).join(ph); hit = true }
    return r
  })
  return hit ? out : null
}

/** Text-only redaction, for logs and messages. */
export function redactText(s: string): string {
  const r = redact(s)
  return typeof r === 'string' ? r : s
}

// ---------------------------------------------------------------- sealing to another bot

export interface Sealed {
  alg: 'x25519-hkdf-sha256-aes256gcm'
  /** Sender's one-time public key. */
  epk: string
  iv: string
  ct: string
  tag: string
}

const SEAL_ALG = 'x25519-hkdf-sha256-aes256gcm' as const
const SEAL_INFO = Buffer.from('tgap-secret-v1')

const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: 'jwk' }).x!, 'base64url').toString('base64')
const publicFromRaw = (b64: string) => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(b64, 'base64').toString('base64url') }, format: 'jwk' })

/** This bot's X25519 key pair, made on first use; the private half is kept under the master key. */
export function boxKeys(): { publicKey: string; privateKey: KeyObject } {
  const row = db().prepare(`SELECT public_key, private_blob FROM secret_keys WHERE id = 'x25519'`).get() as unknown as
    { public_key: string; private_blob: string } | undefined
  if (row) {
    return { publicKey: row.public_key, privateKey: createPrivateKey({ key: Buffer.from(decrypt(row.private_blob, 'x25519'), 'base64'), format: 'der', type: 'pkcs8' }) }
  }
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const pub = rawPublic(publicKey)
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  db().prepare(`INSERT INTO secret_keys (id, public_key, private_blob) VALUES ('x25519', ?, ?)`).run(pub, encrypt(der, 'x25519'))
  return { publicKey: pub, privateKey }
}

function sealKey(shared: Buffer, epk: string, rpk: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(epk + rpk), SEAL_INFO, 32))
}

/** Encrypt for the holder of `recipientPublic` (raw X25519, base64). `aad` binds it to its envelope. */
export function seal(recipientPublic: string, plaintext: string, aad: string): Sealed {
  const eph = generateKeyPairSync('x25519')
  const epk = rawPublic(eph.publicKey)
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(recipientPublic) })
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', sealKey(shared, epk, recipientPublic), iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return { alg: SEAL_ALG, epk, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') }
}

/** Decrypt something sealed to this bot. Throws if it was not, or was altered. */
export function unseal(s: Sealed, aad: string): string {
  if (s?.alg !== SEAL_ALG) throw new Error(`unsupported seal ${s?.alg}`)
  const { publicKey, privateKey } = boxKeys()
  const shared = diffieHellman({ privateKey, publicKey: publicFromRaw(s.epk) })
  const d = createDecipheriv('aes-256-gcm', sealKey(shared, s.epk, publicKey), Buffer.from(s.iv, 'base64'))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(s.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8')
}

/** Test hook: a fresh database and key file per test file. */
export function _resetSecretsForTests(): void {
  ready = null
  masterKey = null
  cache = null
}
