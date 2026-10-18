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
import type { DatabaseSync } from 'node:sqlite'
import { STORE_DIR } from './config.js'
import { getDb } from './db.js'
import {
  ensureVaultSchema, vaultKey, encryptWith, decryptWith, normalizeName, dropExpiredSecrets, writeSecret,
  readSecretMeta, readSecretList, readAllValues, removeSecret, _resetVaultKeysForTests,
  type SecretMeta, type SecretMetaInput,
} from './vault-core.js'

export { VAULT_KEY_FILE, SECRET_NAME, normalizeName, type SecretMeta } from './vault-core.js'

/** Values shorter than this are not redacted from tool output: too many false hits. */
const MIN_REDACT = 4
/**
 * Fields that identify rather than authenticate. They are not taken out of
 * tool output: a login like "admin" is an ordinary word, and redacting it
 * would mangle URLs and pages. The model may see these.
 */
const PUBLIC_FIELDS = new Set(['url', 'host', 'login', 'user', 'username', 'email'])

let ready: DatabaseSync | null = null
let cache: Map<string, Record<string, string>> | null = null
/** PRAGMA data_version when the cache was filled: it moves when another process (the admin panel) writes. */
let cacheVersion = -1

function db(): DatabaseSync {
  const d = getDb()
  if (ready === d) return d
  ensureVaultSchema(d)
  ready = d
  return d
}

const master = () => vaultKey(STORE_DIR)
const encrypt = (plain: string, aad: string) => encryptWith(master(), plain, aad)
const decrypt = (blob: string, aad: string) => decryptWith(master(), blob, aad)

function dataVersion(): number {
  return Number((db().prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
}

function dropExpired(): void {
  if (dropExpiredSecrets(db()) > 0) cache = null
}

// ---------------------------------------------------------------- vault

export function putSecret(name: string, values: Record<string, string>, meta: SecretMetaInput = {}): void {
  writeSecret(db(), master(), name, values, meta)
  cache = null
}

export function getSecretMeta(name: string): SecretMeta | undefined {
  dropExpired()
  return readSecretMeta(db(), name)
}

export function listSecrets(): SecretMeta[] {
  dropExpired()
  return readSecretList(db())
}

export function getSecretValues(name: string): Record<string, string> | undefined {
  return allValues().get(normalizeName(name))
}

export function deleteSecret(name: string): boolean {
  const gone = removeSecret(db(), name)
  cache = null
  return gone
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
  const v = dataVersion()
  if (cache && v === cacheVersion) return cache
  cache = readAllValues(db(), master())
  cacheVersion = v
  return cache
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
  cache = null
  cacheVersion = -1
  _resetVaultKeysForTests()
}
