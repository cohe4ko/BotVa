/**
 * TGAP persistence — peers, every message seen or sent, and request state.
 *
 * Lives in the bot's own botva.db. Peers are keyed by the numeric Telegram id
 * of the other bot: usernames can change, ids cannot (spec §8.1).
 */

import type { DatabaseSync } from 'node:sqlite'
import { getDb } from '../db.js'
import type { Envelope } from './envelope.js'
import { addShareRevokeColumn } from './share-revoke.js'

export type Trust = 'unknown' | 'known' | 'trusted' | 'blocked'
export type PeerProtocol = 'tgap' | 'plain'

export type RequestState =
  | 'submitted' | 'received' | 'drafting' | 'pending_approval' | 'editing' | 'revising'
  | 'completed' | 'declined' | 'failed' | 'expired' | 'cancelled'

export const FINAL_STATES: ReadonlySet<RequestState> = new Set(['completed', 'declined', 'failed', 'expired', 'cancelled'])

export interface Peer {
  bot_id: number
  username: string | null
  trust: Trust
  protocol: PeerProtocol | null
  card: string | null
  first_seen: number
  last_seen: number
}

export interface RequestRow {
  id: string
  direction: 'in' | 'out'
  peer_id: number
  conv: string
  turn: number
  hop: number
  kind: string
  text: string
  state: RequestState
  plain: number
  owner_chat: string
  draft: string | null
  final_text: string | null
  approval: string | null
  expires_at: number | null
  card_message_id: number | null
  edit_prompt_id: number | null
  /** Incoming: the reply variants offered to the owner (JSON Variant[]). */
  variants: string | null
  /** Proposals (§4.3): the structured proposal, JSON. */
  proposal: string | null
  /** Outgoing: 'inquiry' or 'may_commit'. */
  authority: string | null
  /** Outgoing may_commit: the owner's limits in their own words. Never sent to the peer. */
  mandate: string | null
  /** The decision on a proposal: accepted, rejected or counter. */
  decision: string | null
  created_at: number
  updated_at: number
}

/** Open states of an incoming request, before the answer goes out. */
export const OPEN_IN_STATES: RequestState[] = ['received', 'drafting', 'pending_approval', 'editing', 'revising']

/** How long message ids are remembered for deduplication (§7.3). */
export const DEDUP_TTL_S = 7 * 24 * 3600

let ready: DatabaseSync | null = null

function db(): DatabaseSync {
  const d = getDb()
  if (ready === d) return d
  d.exec(`
    CREATE TABLE IF NOT EXISTS tgap_peers (
      bot_id INTEGER PRIMARY KEY,
      username TEXT,
      trust TEXT NOT NULL DEFAULT 'unknown',
      protocol TEXT,
      card TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tgap_messages (
      id TEXT NOT NULL,
      direction TEXT NOT NULL,
      peer_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      conv TEXT,
      re TEXT,
      envelope TEXT NOT NULL,
      tg_message_id INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (id, direction, peer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tgap_messages_conv ON tgap_messages(conv, created_at);
    CREATE TABLE IF NOT EXISTS tgap_requests (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      peer_id INTEGER NOT NULL,
      conv TEXT NOT NULL,
      turn INTEGER NOT NULL,
      hop INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL,
      plain INTEGER NOT NULL DEFAULT 0,
      owner_chat TEXT NOT NULL,
      draft TEXT,
      final_text TEXT,
      approval TEXT,
      expires_at INTEGER,
      card_message_id INTEGER,
      edit_prompt_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tgap_requests_state ON tgap_requests(state, expires_at);
    CREATE TABLE IF NOT EXISTS tgap_secret_shares (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      peer_id INTEGER NOT NULL,
      conv TEXT NOT NULL,
      name TEXT NOT NULL,
      fields TEXT NOT NULL,
      note TEXT,
      secret_expires_at INTEGER,
      sealed TEXT,
      state TEXT NOT NULL,
      stored_name TEXT,
      tg_message_id INTEGER,
      card_message_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tgap_secret_shares_peer ON tgap_secret_shares(peer_id, state);
    CREATE TABLE IF NOT EXISTS tgap_convs (
      conv TEXT PRIMARY KEY,
      peer_id INTEGER NOT NULL,
      max_turns INTEGER NOT NULL,
      last_turn INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `)
  for (const col of ['variants TEXT', 'proposal TEXT', 'authority TEXT', 'mandate TEXT', 'decision TEXT']) {
    try { d.exec(`ALTER TABLE tgap_requests ADD COLUMN ${col}`) } catch { /* already there */ }
  }
  addShareRevokeColumn(d)
  ready = d
  return d
}

const now = () => Math.floor(Date.now() / 1000)

// --- peers ---

export function getPeer(botId: number): Peer | undefined {
  return db().prepare('SELECT * FROM tgap_peers WHERE bot_id = ?').get(botId) as unknown as Peer | undefined
}

export function findPeerByUsername(username: string): Peer | undefined {
  const u = username.replace(/^@/, '').toLowerCase()
  return db().prepare('SELECT * FROM tgap_peers WHERE lower(username) = ?').get(u) as unknown as Peer | undefined
}

/** Record that a peer was seen; creates it as `unknown` the first time. */
export function touchPeer(botId: number, username?: string | null): Peer {
  const t = now()
  db().prepare(`
    INSERT INTO tgap_peers (bot_id, username, first_seen, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(bot_id) DO UPDATE SET last_seen = excluded.last_seen,
      username = COALESCE(excluded.username, tgap_peers.username)
  `).run(botId, username ? username.replace(/^@/, '') : null, t, t)
  return getPeer(botId)!
}

export function setPeerTrust(botId: number, trust: Trust): void {
  db().prepare('UPDATE tgap_peers SET trust = ? WHERE bot_id = ?').run(trust, botId)
}

export function setPeerProtocol(botId: number, protocol: PeerProtocol, card?: string): void {
  db().prepare('UPDATE tgap_peers SET protocol = ?, card = COALESCE(?, card) WHERE bot_id = ?').run(protocol, card ?? null, botId)
}

export function listPeers(): Peer[] {
  return db().prepare('SELECT * FROM tgap_peers ORDER BY last_seen DESC').all() as unknown as Peer[]
}

// --- messages (dedup + audit) ---

/**
 * Remember an incoming message id. Returns false if it was already seen — the
 * caller must drop it silently (§7.3).
 */
export function recordIncoming(peerId: number, env: Envelope, tgMessageId?: number): boolean {
  const r = db().prepare(`
    INSERT OR IGNORE INTO tgap_messages (id, direction, peer_id, type, conv, re, envelope, tg_message_id, created_at)
    VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?)
  `).run(env.id, peerId, env.type, env.conv ?? null, env.re ?? null, JSON.stringify(env), tgMessageId ?? null, now())
  return Number(r.changes) > 0
}

export function recordOutgoing(peerId: number, env: Envelope, tgMessageId?: number): void {
  db().prepare(`
    INSERT OR REPLACE INTO tgap_messages (id, direction, peer_id, type, conv, re, envelope, tg_message_id, created_at)
    VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?)
  `).run(env.id, peerId, env.type, env.conv ?? null, env.re ?? null, JSON.stringify(env), tgMessageId ?? null, now())
}

/** The conversation so far, oldest first — context for drafting a reply. */
export function convMessages(conv: string, limit = 20): Array<{ direction: 'in' | 'out'; envelope: Envelope }> {
  const rows = db().prepare(`
    SELECT direction, envelope FROM tgap_messages WHERE conv = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(conv, limit) as unknown as Array<{ direction: 'in' | 'out'; envelope: string }>
  return rows.reverse().map(r => ({ direction: r.direction, envelope: JSON.parse(r.envelope) }))
}

export function pruneMessages(): void {
  db().prepare('DELETE FROM tgap_messages WHERE created_at < ?').run(now() - DEDUP_TTL_S * 4)
}

// --- conversations ---

export interface Conv { conv: string; peer_id: number; max_turns: number; last_turn: number }

export function getConv(conv: string): Conv | undefined {
  return db().prepare('SELECT conv, peer_id, max_turns, last_turn FROM tgap_convs WHERE conv = ?').get(conv) as unknown as Conv | undefined
}

export function upsertConv(conv: string, peerId: number, maxTurns: number): Conv {
  db().prepare(`
    INSERT INTO tgap_convs (conv, peer_id, max_turns, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(conv) DO NOTHING
  `).run(conv, peerId, maxTurns, now())
  return getConv(conv)!
}

export function advanceConv(conv: string, turn: number): void {
  db().prepare('UPDATE tgap_convs SET last_turn = MAX(last_turn, ?) WHERE conv = ?').run(turn, conv)
}

// --- requests ---

type NewRequest = Omit<RequestRow, 'created_at' | 'updated_at' | 'draft' | 'final_text' | 'approval' | 'card_message_id' | 'edit_prompt_id'
  | 'variants' | 'proposal' | 'authority' | 'mandate' | 'decision'> & Partial<Pick<RequestRow, 'proposal' | 'authority' | 'mandate'>>

export function insertRequest(r: NewRequest): void {
  const t = now()
  db().prepare(`
    INSERT INTO tgap_requests (id, direction, peer_id, conv, turn, hop, kind, text, state, plain, owner_chat, expires_at, proposal, authority, mandate, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.id, r.direction, r.peer_id, r.conv, r.turn, r.hop, r.kind, r.text, r.state, r.plain, r.owner_chat, r.expires_at,
    r.proposal ?? null, r.authority ?? null, r.mandate ?? null, t, t)
}

export function getRequest(id: string): RequestRow | undefined {
  return db().prepare('SELECT * FROM tgap_requests WHERE id = ?').get(id) as unknown as RequestRow | undefined
}

type Patch = Partial<Pick<RequestRow, 'state' | 'draft' | 'final_text' | 'approval' | 'card_message_id' | 'edit_prompt_id' | 'variants' | 'decision'>>

export function updateRequest(id: string, patch: Patch): void {
  const keys = Object.keys(patch) as Array<keyof Patch>
  if (keys.length === 0) return
  const sets = keys.map(k => `${k} = ?`).join(', ')
  db().prepare(`UPDATE tgap_requests SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map(k => patch[k] ?? null), now(), id)
}

/** Move a request to `to` only if it is currently in one of `from` — guards double clicks and races. */
export function transition(id: string, from: RequestState[], to: RequestState): boolean {
  const marks = from.map(() => '?').join(', ')
  const r = db().prepare(`UPDATE tgap_requests SET state = ?, updated_at = ? WHERE id = ? AND state IN (${marks})`).run(to, now(), id, ...from)
  return Number(r.changes) > 0
}

export function findRequestByEditPrompt(ownerChat: string, promptId: number): RequestRow | undefined {
  return db().prepare(`SELECT * FROM tgap_requests WHERE owner_chat = ? AND edit_prompt_id = ? AND state IN ('editing', 'revising')`)
    .get(ownerChat, promptId) as unknown as RequestRow | undefined
}

/** Our proposal whose counter the owner is answering with their own text. */
export function findCounterPrompt(ownerChat: string, promptId: number): RequestRow | undefined {
  return db().prepare(`SELECT * FROM tgap_requests WHERE direction = 'out' AND owner_chat = ? AND edit_prompt_id = ? AND decision = 'counter'`)
    .get(ownerChat, promptId) as unknown as RequestRow | undefined
}

/** The newest open outgoing request to a peer — where a plain-text answer most likely belongs. */
export function latestOpenOutgoing(peerId: number): RequestRow | undefined {
  return db().prepare(`
    SELECT * FROM tgap_requests WHERE direction = 'out' AND peer_id = ? AND state IN ('submitted', 'received', 'pending_approval')
    ORDER BY created_at DESC LIMIT 1
  `).get(peerId) as unknown as RequestRow | undefined
}

export function expiredOpenRequests(at = now()): RequestRow[] {
  return db().prepare(`
    SELECT * FROM tgap_requests WHERE expires_at IS NOT NULL AND expires_at <= ?
      AND state IN ('submitted', 'received', 'drafting', 'pending_approval', 'editing', 'revising')
  `).all(at) as unknown as RequestRow[]
}

/** How many requests this peer sent us since `sinceS` — for the inbound rate limit. */
export function countIncomingSince(peerId: number, sinceS: number): number {
  const r = db().prepare(`SELECT COUNT(*) AS n FROM tgap_requests WHERE direction = 'in' AND peer_id = ? AND created_at >= ?`)
    .get(peerId, sinceS) as unknown as { n: number }
  return Number(r.n)
}

// --- secret shares ---

/**
 * out: awaiting_key → sent → delivered | declined | revoked | failed
 * in:  pending → accepted | declined | revoked | expired
 */
export type ShareState = 'awaiting_key' | 'sent' | 'delivered' | 'declined' | 'revoked' | 'failed' | 'pending' | 'accepted' | 'expired'

export interface ShareRow {
  id: string
  direction: 'in' | 'out'
  peer_id: number
  conv: string
  name: string
  fields: string
  note: string | null
  secret_expires_at: number | null
  /** Incoming only, until the owner decides: the still-encrypted secret. */
  sealed: string | null
  state: ShareState
  stored_name: string | null
  tg_message_id: number | null
  card_message_id: number | null
  /** Set by the admin panel: revoke this share on the next sweep. */
  revoke_requested: number | null
  created_at: number
  updated_at: number
}

export function revokeRequestedShares(): ShareRow[] {
  return db().prepare(`SELECT * FROM tgap_secret_shares WHERE direction = 'out' AND revoke_requested IS NOT NULL ORDER BY revoke_requested`).all() as unknown as ShareRow[]
}

export function clearRevokeRequest(id: string): void {
  db().prepare('UPDATE tgap_secret_shares SET revoke_requested = NULL WHERE id = ?').run(id)
}

export function insertShare(r: Pick<ShareRow, 'id' | 'direction' | 'peer_id' | 'conv' | 'name' | 'fields' | 'note' | 'secret_expires_at' | 'sealed' | 'state'>): void {
  const t = now()
  db().prepare(`
    INSERT INTO tgap_secret_shares (id, direction, peer_id, conv, name, fields, note, secret_expires_at, sealed, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.id, r.direction, r.peer_id, r.conv, r.name, r.fields, r.note, r.secret_expires_at, r.sealed, r.state, t, t)
}

export function getShare(id: string): ShareRow | undefined {
  return db().prepare('SELECT * FROM tgap_secret_shares WHERE id = ?').get(id) as unknown as ShareRow | undefined
}

type SharePatch = Partial<Pick<ShareRow, 'sealed' | 'stored_name' | 'tg_message_id' | 'card_message_id'>>

export function updateShare(id: string, patch: SharePatch): void {
  const keys = Object.keys(patch) as Array<keyof SharePatch>
  if (keys.length === 0) return
  const sets = keys.map(k => `${k} = ?`).join(', ')
  db().prepare(`UPDATE tgap_secret_shares SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map(k => patch[k] ?? null), now(), id)
}

/** Move a share to `to` only from one of `from`. Leaving a pending state always drops the sealed copy. */
export function transitionShare(id: string, from: ShareState[], to: ShareState): boolean {
  const marks = from.map(() => '?').join(', ')
  const clear = ['accepted', 'declined', 'revoked', 'expired', 'failed'].includes(to) ? ', sealed = NULL' : ''
  const r = db().prepare(`UPDATE tgap_secret_shares SET state = ?${clear}, updated_at = ? WHERE id = ? AND state IN (${marks})`).run(to, now(), id, ...from)
  return Number(r.changes) > 0
}

export function sharesByState(direction: 'in' | 'out', states: ShareState[], peerId?: number): ShareRow[] {
  const marks = states.map(() => '?').join(', ')
  const byPeer = peerId === undefined ? '' : ' AND peer_id = ?'
  return db().prepare(`SELECT * FROM tgap_secret_shares WHERE direction = ? AND state IN (${marks})${byPeer} ORDER BY created_at`)
    .all(direction, ...states, ...(peerId === undefined ? [] : [peerId])) as unknown as ShareRow[]
}

/** Test hook: forget the cached schema check (a fresh temp db per test file). */
export function _resetForTests(): void {
  ready = null
}
