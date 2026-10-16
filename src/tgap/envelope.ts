/**
 * TGAP envelope — reading and writing the machine part of a TGAP message.
 *
 * A TGAP message is ordinary Telegram text: a human-readable preamble, then a
 * JSON envelope in a `pre` entity whose language is `tgap`. Only the envelope
 * counts; the preamble is there for bots that don't speak the protocol and for
 * humans reading logs. See docs/tgap-spec.md §2–§4.
 */

import { randomBytes } from 'node:crypto'

export const TGAP_VERSION = '0.1'
export const TGAP_LANGUAGE = 'tgap'

/** Telegram's hard limit on a text message, in UTF-16 code units. */
export const MAX_TEXT = 4096
/** Envelopes longer than this travel as a JSON document instead (§2.3). */
export const MAX_INLINE_ENVELOPE = 3500

export const TGAP_TYPES = ['hello', 'card', 'request', 'status', 'response', 'decline', 'cancel', 'error', 'secret', 'revoke'] as const
export type TgapType = typeof TGAP_TYPES[number]

/**
 * The only types that may cause an automatic message back (§7.1). A `secret`
 * is answered too, but only once its receiver's owner decides (§4.8).
 */
export const ELICITING: ReadonlySet<TgapType> = new Set(['hello', 'request'])

export type ErrorCode =
  | 'malformed' | 'unsupported' | 'version' | 'too_large' | 'rate_limited'
  | 'turn_limit' | 'hop_limit' | 'unknown_conv' | 'internal'

export type DeclineReason = 'owner_declined' | 'not_accepting' | 'out_of_scope' | 'expired' | 'blocked'

export type Approval = 'owner' | 'policy' | 'none'

export interface Envelope {
  tgap: string
  type: TgapType
  id: string
  conv?: string
  re?: string
  turn?: number
  hop?: number
  expires_at?: string
  attachment?: boolean
  body: Record<string, any>
}

export interface Card {
  name: string
  owner: { display_name: string }
  software?: { name: string; version?: string }
  tgap: string[]
  kinds: string[]
  approval: 'owner_always' | 'owner_or_policy'
  languages?: string[]
  max_request_chars?: number
  accepts_from: 'anyone' | 'known_only'
  about?: string
  /** Present when the bot can receive sealed secrets (§4.8): its X25519 public key, raw, base64. */
  secrets?: { x25519: string }
}

/** Minimal Telegram MessageEntity shape — only what TGAP reads and writes. */
export interface Entity {
  type: string
  offset: number
  length: number
  language?: string
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ULID: 48-bit millisecond time + 80 random bits, Crockford base32, sortable by time. */
export function newId(now = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const rnd = randomBytes(16)
  let random = ''
  for (let i = 0; i < 16; i++) random += CROCKFORD[rnd[i] % 32]
  return time + random
}

export type ParseResult =
  | { kind: 'envelope'; env: Envelope }
  | { kind: 'plain'; text: string }
  | { kind: 'invalid'; code: ErrorCode; reason: string; id?: string }

/**
 * Check the shape of a decoded envelope. Returns an error code and reason, or
 * null if it is acceptable. Unknown fields are allowed (§3.1).
 */
export function validateEnvelope(obj: unknown): { code: ErrorCode; reason: string } | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { code: 'malformed', reason: 'envelope is not an object' }
  const e = obj as Record<string, unknown>
  if (typeof e.tgap !== 'string') return { code: 'malformed', reason: 'missing tgap version' }
  const major = e.tgap.split('.')[0]
  if (major !== TGAP_VERSION.split('.')[0]) return { code: 'version', reason: `unsupported major version ${e.tgap}` }
  if (typeof e.id !== 'string' || !e.id || e.id.length > 64) return { code: 'malformed', reason: 'missing or bad id' }
  if (typeof e.type !== 'string') return { code: 'malformed', reason: 'missing type' }
  if (!(TGAP_TYPES as readonly string[]).includes(e.type)) return { code: 'unsupported', reason: `unknown type ${e.type}` }
  // A stub only announces the document that carries the real envelope (§2.3);
  // the full checks run on that document.
  if (e.attachment === true) return null
  if (!e.body || typeof e.body !== 'object' || Array.isArray(e.body)) return { code: 'malformed', reason: 'missing body' }
  // An error may answer a message too broken to have a readable conv.
  if (!['hello', 'card', 'error'].includes(e.type) && typeof e.conv !== 'string') return { code: 'malformed', reason: 'missing conv' }
  if (['card', 'status', 'response', 'decline', 'cancel', 'revoke'].includes(e.type) && typeof e.re !== 'string') {
    return { code: 'malformed', reason: `${e.type} needs re` }
  }
  if (e.type === 'request') {
    if (!Number.isInteger(e.turn) || (e.turn as number) < 1) return { code: 'malformed', reason: 'request needs turn >= 1' }
    if (!Number.isInteger(e.hop) || (e.hop as number) < 0) return { code: 'malformed', reason: 'request needs hop >= 0' }
    const b = e.body as Record<string, unknown>
    if (!['question', 'proposal', 'notice'].includes(String(b.kind))) return { code: 'malformed', reason: 'request needs kind' }
    if (typeof b.text !== 'string' || !b.text.trim()) return { code: 'malformed', reason: 'request needs text' }
  }
  if (e.type === 'secret') {
    const b = e.body as Record<string, any>
    if (typeof b.name !== 'string' || !b.name.trim()) return { code: 'malformed', reason: 'secret needs name' }
    if (!Array.isArray(b.fields) || !b.fields.every((f: unknown) => typeof f === 'string')) return { code: 'malformed', reason: 'secret needs fields' }
    const s = b.sealed
    if (!s || typeof s !== 'object' || !['alg', 'epk', 'iv', 'ct', 'tag'].every(k => typeof s[k] === 'string')) return { code: 'malformed', reason: 'secret needs sealed' }
  }
  if (e.type === 'response' && !['owner', 'policy', 'none'].includes(String((e.body as any).approval))) {
    return { code: 'malformed', reason: 'response needs approval' }
  }
  return null
}

/** Decode one envelope from raw JSON text. */
export function parseEnvelopeJson(json: string): ParseResult {
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    return { kind: 'invalid', code: 'malformed', reason: 'envelope is not valid JSON' }
  }
  const id = typeof (obj as any)?.id === 'string' ? (obj as any).id : undefined
  const bad = validateEnvelope(obj)
  if (bad) return { kind: 'invalid', ...bad, id }
  return { kind: 'envelope', env: obj as Envelope }
}

/**
 * Find the envelope in a Telegram message. Offsets are UTF-16 code units —
 * the same units JavaScript strings use, so slicing works directly.
 */
export function parseMessage(text: string | undefined, entities: Entity[] | undefined): ParseResult {
  const t = text ?? ''
  const blocks = (entities ?? []).filter(e => e.type === 'pre' && e.language === TGAP_LANGUAGE)
  if (blocks.length === 0) return { kind: 'plain', text: t }
  if (blocks.length > 1) return { kind: 'invalid', code: 'malformed', reason: 'more than one tgap block' }
  const b = blocks[0]
  return parseEnvelopeJson(t.slice(b.offset, b.offset + b.length))
}

export type Rendered =
  | { kind: 'text'; text: string; entities: Entity[] }
  | { kind: 'document'; filename: string; json: string; caption: string; entities: Entity[] }

/** Compose preamble + envelope into one message, or a document when it doesn't fit (§2.3). */
export function renderMessage(preamble: string, env: Envelope): Rendered {
  const json = JSON.stringify(env)
  const head = preamble.trim()
  if (json.length <= MAX_INLINE_ENVELOPE) {
    const prefix = head ? head + '\n\n' : ''
    const text = prefix + json
    if (text.length <= MAX_TEXT) {
      return { kind: 'text', text, entities: [{ type: 'pre', offset: prefix.length, length: json.length, language: TGAP_LANGUAGE }] }
    }
  }
  const stub = JSON.stringify({ tgap: env.tgap, type: env.type, id: env.id, attachment: true })
  const shortHead = head.slice(0, 600)
  const prefix = shortHead ? shortHead + '\n\n' : ''
  return {
    kind: 'document',
    filename: `tgap-${env.id}.json`,
    json,
    caption: prefix + stub,
    entities: [{ type: 'pre', offset: prefix.length, length: stub.length, language: TGAP_LANGUAGE }],
  }
}

/** Build an envelope with the common fields filled in. */
export function envelope(type: TgapType, body: Record<string, any>, fields: Partial<Omit<Envelope, 'tgap' | 'type' | 'body'>> = {}): Envelope {
  return { tgap: TGAP_VERSION, type, id: fields.id ?? newId(), ...fields, body }
}
