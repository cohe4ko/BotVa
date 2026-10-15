/**
 * Telegram Observer — MTProto client wrapper (GramJS).
 *
 * Owns the session file, entity classification and the small set of account
 * actions the daemon exposes. Deliberately thin: no logging policy, no MCP
 * concerns — those live in log.ts and mcp.ts.
 */

import { TelegramClient, Api } from 'telegram'
import bigInt from 'big-integer'
import { CustomFile } from 'telegram/client/uploads.js'
import { StringSession } from 'telegram/sessions/index.js'
import { getPeerId, getDisplayName, getInputUser } from 'telegram/Utils.js'
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { TG_SESSION_PATH, PROJECT_ROOT, TG_MEDIA_DIR } from './paths.js'
import { throttled, typingDelayMs } from './throttle.js'
import type { ChatKind, ChatMode } from './db.js'

/** Hard caps on how much a single call may ask for, regardless of the caller. */
export const MAX_DIALOGS = 100
export const MAX_HISTORY = 100

export interface ApiCredentials {
  apiId: number
  apiHash: string
}

/**
 * Read credentials from process.env, falling back to the project-level .env.
 *
 * The daemon and the admin UI run in different processes; both need the same
 * two values, and neither is a per-bot concern, so they live in the root .env.
 */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): ApiCredentials | null {
  let apiId = Number(env['TELEGRAM_API_ID'] ?? '')
  let apiHash = env['TELEGRAM_API_HASH'] ?? ''

  if (!apiId || !apiHash) {
    const fromFile = readProjectEnv()
    apiId = apiId || Number(fromFile['TELEGRAM_API_ID'] ?? '')
    apiHash = apiHash || (fromFile['TELEGRAM_API_HASH'] ?? '')
  }

  if (!apiId || !apiHash) return null
  return { apiId, apiHash }
}

function readProjectEnv(): Record<string, string> {
  const envPath = resolve(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      out[key] = value
    }
  } catch { /* unreadable .env is the same as absent */ }
  return out
}

// --- Session file ---

export function loadSession(): string {
  if (!existsSync(TG_SESSION_PATH)) return ''
  try {
    return readFileSync(TG_SESSION_PATH, 'utf-8').trim()
  } catch {
    return ''
  }
}

/** Persist the session string with owner-only permissions. */
export function saveSession(session: string): void {
  mkdirSync(dirname(TG_SESSION_PATH), { recursive: true })
  writeFileSync(TG_SESSION_PATH, session, 'utf-8')
  try { chmodSync(TG_SESSION_PATH, 0o600) } catch { /* best effort on exotic filesystems */ }
}

export function hasSession(): boolean {
  return loadSession().length > 0
}

// --- Client ---

export interface ConnectionTuning {
  connectionRetries: number
  retryDelay: number
}

/**
 * Interactive login: a person is waiting on the admin form, so failing fast is
 * the honest answer — better an error they can retry than a spinner forever.
 */
export const INTERACTIVE_CONNECTION: ConnectionTuning = { connectionRetries: 10, retryDelay: 2000 }

/**
 * The daemon must outlive an outage of any length.
 *
 * A bounded retry budget is a time bomb here: ten attempts two seconds apart
 * means any loss of connectivity longer than twenty seconds ends the update
 * loop permanently, while the process stays up and keeps reporting health.
 * That is exactly what happened on 5 Sep 2026 — the socket died at 18:36, the
 * ten attempts were spent by 21:24, and the observer went on to see nothing at
 * all for the next 21 hours. A failed attempt against a dead network costs
 * nothing, so there is no reason to ever stop trying.
 */
export const RESILIENT_CONNECTION: ConnectionTuning = { connectionRetries: Infinity, retryDelay: 3000 }

export function createClient(
  creds: ApiCredentials,
  session = loadSession(),
  tuning: ConnectionTuning = INTERACTIVE_CONNECTION,
): TelegramClient {
  return new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, {
    connectionRetries: tuning.connectionRetries,
    retryDelay: tuning.retryDelay,
    autoReconnect: true,
    // GramJS logs verbosely at info level; the daemon has its own logging.
    baseLogger: undefined,
  })
}

/** Connect and verify the stored session is still valid. */
export async function connectAuthorized(client: TelegramClient): Promise<boolean> {
  await client.connect()
  return client.isUserAuthorized()
}

// --- Entity classification ---

export interface ChatInfo {
  chat_id: string
  title: string
  username: string | null
  kind: ChatKind
}

/**
 * Map a Telegram entity to our chat registry shape.
 * `getPeerId` gives the marked id (-100… for channels), stable across sessions.
 */
export function classifyEntity(entity: Api.TypeUser | Api.TypeChat | Api.TypeInputPeer | unknown): ChatInfo | null {
  if (!entity || typeof entity !== 'object') return null

  // Structural read: the concrete Api classes have conflicting shapes, so an
  // intersection type collapses to never. className is the discriminator.
  const e = entity as { className?: string; bot?: boolean; megagroup?: boolean; username?: string }
  let kind: ChatKind

  switch (e.className) {
    case 'User':
      kind = e.bot ? 'bot' : 'user'
      break
    case 'Chat':
    case 'ChatForbidden':
      kind = 'group'
      break
    case 'Channel':
    case 'ChannelForbidden':
      kind = e.megagroup ? 'supergroup' : 'channel'
      break
    default:
      return null
  }

  let chat_id: string
  try {
    chat_id = getPeerId(entity as never)
  } catch {
    return null
  }

  return {
    chat_id,
    title: getDisplayName(entity as never) || chat_id,
    username: e.username ?? null,
    kind,
  }
}

/**
 * Telegram's own service account. It delivers login codes and security alerts —
 * one-time secrets that must never be written to a plaintext database.
 */
export const SERVICE_CHAT_ID = '777000'

/**
 * Default logging mode for a freshly seen chat.
 *
 * Bots are hard-ignored: BotVa's own bots message the same account, and logging
 * them would feed the observer its own output.
 */
export function defaultModeFor(kind: ChatKind, chatId?: string): ChatMode {
  if (chatId === SERVICE_CHAT_ID) return 'ignore'
  switch (kind) {
    case 'bot': return 'ignore'
    case 'user': return 'log-only'
    case 'group': return 'log-only'
    case 'supergroup': return 'ignore'
    case 'channel': return 'ignore'
  }
}

// --- Account actions ---

export interface DialogSummary {
  chat_id: string
  title: string
  username: string | null
  kind: ChatKind
  unread: number
  last_message: string
  last_ts: number | null
}

export async function listDialogs(client: TelegramClient, limit = 100): Promise<DialogSummary[]> {
  const dialogs = await throttled('getDialogs', () => client.getDialogs({ limit: Math.min(limit, MAX_DIALOGS) }))
  const out: DialogSummary[] = []
  for (const d of dialogs) {
    const info = classifyEntity(d.entity)
    if (!info) continue
    out.push({
      ...info,
      unread: d.unreadCount ?? 0,
      last_message: d.message?.message?.slice(0, 200) ?? '',
      last_ts: d.message?.date ?? null,
    })
  }
  return out
}

export interface HistoryMessage {
  msg_id: number
  direction: 'in' | 'out'
  /** Needed to tell participants apart in a group, and to seed the log faithfully. */
  sender_id: string | null
  sender_name: string
  text: string
  media_type: string | null
  reply_to: number | null
  ts: number
}

export async function getHistory(
  client: TelegramClient,
  chat: string,
  limit = 30,
): Promise<HistoryMessage[]> {
  const messages = await throttled('getMessages', () =>
    client.getMessages(chat, { limit: Math.min(limit, MAX_HISTORY) }))

  const out: HistoryMessage[] = []
  for (const m of messages) {
    if (!m) continue
    out.push({
      msg_id: m.id,
      direction: m.out ? 'out' : 'in',
      sender_id: m.senderId ? String(m.senderId) : null,
      sender_name: senderNameFromCache(m),
      text: m.message ?? '',
      media_type: mediaTypeOf(m),
      reply_to: m.replyTo?.replyToMsgId ?? null,
      ts: m.date,
    })
  }
  return out.reverse() // chronological
}

/**
 * Sender name without a network round-trip.
 *
 * `message.getSender()` resolves the entity, and on a cache miss that is a
 * separate API call — once per message. Reading a 200-message history would
 * then cost 200 extra requests, which is exactly the pattern that earns a
 * FLOOD_WAIT. An unnamed sender is a cosmetic loss; a rate limit is not.
 */
export function senderNameFromCache(message: unknown): string {
  const m = message as {
    _sender?: unknown
    sender?: unknown
    out?: boolean
    senderId?: unknown
  }
  const cached = m._sender ?? m.sender
  if (cached) {
    try {
      const name = getDisplayName(cached as never)
      if (name) return name
    } catch { /* entity shape not nameable */ }
  }
  // No cached entity: leave the name empty rather than storing a bare numeric
  // id. A reader — human or model — takes "700100200" for a participant, and
  // callers already have the chat title to fall back on.
  return ''
}

export interface SenderProfile {
  name: string
  username: string
  isBot: boolean
}

/**
 * Everything the update already knows about who sent it.
 *
 * Same contract as senderNameFromCache — cache only, never a network lookup —
 * but returns the handle and the bot flag too, which the people register needs
 * and which would otherwise cost one request per message to learn.
 */
export function senderProfileFromCache(message: unknown): SenderProfile {
  const m = message as { _sender?: unknown; sender?: unknown }
  const cached = (m._sender ?? m.sender) as { username?: string; bot?: boolean } | undefined
  return {
    name: senderNameFromCache(message),
    username: typeof cached?.username === 'string' ? cached.username : '',
    isBot: cached?.bot === true,
  }
}

export function mediaTypeOf(message: { media?: unknown }): string | null {
  const media = message.media as { className?: string } | undefined
  if (!media?.className) return null
  switch (media.className) {
    case 'MessageMediaPhoto': return 'photo'
    case 'MessageMediaDocument': return 'document'
    case 'MessageMediaWebPage': return null // link preview, not an attachment
    case 'MessageMediaGeo':
    case 'MessageMediaGeoLive': return 'location'
    case 'MessageMediaContact': return 'contact'
    case 'MessageMediaPoll': return 'poll'
    default: return media.className.replace(/^MessageMedia/, '').toLowerCase()
  }
}

/**
 * Send text, preceded by a typing indicator and a delay scaled to its length.
 *
 * An instant reply is the clearest signal that nobody typed it. The indicator
 * also makes the pause read as normal to the person on the other side.
 */
export async function sendText(client: TelegramClient, chat: string, text: string): Promise<number> {
  const delay = typingDelayMs(text)
  try {
    await throttled('setTyping', () => client.invoke(new Api.messages.SetTyping({
      peer: chat,
      action: new Api.SendMessageTypingAction(),
    })))
  } catch { /* the indicator is cosmetic — never block the send on it */ }

  await new Promise(resolve => setTimeout(resolve, delay))

  const msg = await throttled('sendMessage', () => client.sendMessage(chat, { message: text }))
  return msg.id
}

export async function sendFile(
  client: TelegramClient,
  chat: string,
  path: string,
  caption?: string,
  asDocument = false,
): Promise<number> {
  const msg = await throttled('sendFile', () => client.sendFile(chat, {
    file: path,
    caption,
    forceDocument: asDocument,
  }))
  return msg.id
}

export async function resolveChat(client: TelegramClient, query: string): Promise<ChatInfo | null> {
  try {
    const entity = await throttled('getEntity', () => client.getEntity(query))
    return classifyEntity(entity)
  } catch {
    return null
  }
}

export async function markRead(client: TelegramClient, chat: string): Promise<void> {
  await throttled('markAsRead', () => client.markAsRead(chat))
}

/**
 * Only the owner's own messages in a chat.
 *
 * Server-side filtering, not a scan: `fromUser` turns this into one
 * `messages.search` with a sender filter, so a group where the owner wrote
 * twenty lines among ten thousand costs the same as any other history read.
 *
 * This is what makes style work in a group. Reading the last four hundred
 * messages of a busy room yields a handful of his lines drowned in everyone
 * else's; asking for his alone gives the same budget spent entirely on signal.
 */
export async function getOwnHistory(
  client: TelegramClient,
  chat: string,
  limit = 50,
): Promise<HistoryMessage[]> {
  const messages = await throttled('getMessages.own', () =>
    client.getMessages(chat, { limit: Math.min(limit, MAX_HISTORY), fromUser: 'me' }))

  const out: HistoryMessage[] = []
  for (const m of messages) {
    if (!m) continue
    out.push({
      msg_id: m.id,
      direction: 'out',
      sender_id: m.senderId ? String(m.senderId) : null,
      sender_name: senderNameFromCache(m),
      text: m.message ?? '',
      media_type: mediaTypeOf(m),
      reply_to: m.replyTo?.replyToMsgId ?? null,
      ts: m.date,
    })
  }
  return out.reverse() // chronological
}

export interface PeerState {
  chat_id: string
  unread: number
  /** Highest message id the owner has read in this chat. */
  read_inbox_max_id: number
}

/**
 * Live read state for one chat.
 *
 * The locally tracked counter cannot see the owner opening the chat on their
 * phone. Anything about to speak on their behalf must ask Telegram first, and
 * one dialog lookup is cheap enough to do at that moment only.
 */
export async function getPeerState(client: TelegramClient, chat: string): Promise<PeerState | null> {
  const peer = await throttled('getPeerState.getInputEntity', () => client.getInputEntity(chat))
  const res = await throttled('getPeerState.getPeerDialogs', () =>
    client.invoke(new Api.messages.GetPeerDialogs({
      peers: [new Api.InputDialogPeer({ peer })],
    })))

  const dialog = res.dialogs.find(d => d.className === 'Dialog') as Api.Dialog | undefined
  if (!dialog) return null
  return {
    chat_id: String(chat),
    unread: dialog.unreadCount ?? 0,
    read_inbox_max_id: dialog.readInboxMaxId ?? 0,
  }
}

/** Upper bound on one roster pull, so a 5000-member group cannot bury us. */
export const MAX_PARTICIPANTS = 500

export interface Participant {
  peer_id: string
  display_name: string
  username: string
  is_bot: boolean
  status: string
}

export interface ParticipantsResult {
  members: Participant[]
  /** What Telegram says the chat holds, when it is willing to say. */
  total: number
  /** True when `total` exceeds what this account was allowed to enumerate. */
  truncated: boolean
}

/**
 * Who is in a chat, as opposed to who has spoken in it.
 *
 * The message log answers the second question and is useless for the first: a
 * member who never writes leaves no trace, and someone who left is all over it.
 *
 * Cost differs sharply by chat type. A basic group is one `messages.GetFullChat`
 * and the whole roster comes back; a supergroup is `channels.GetParticipants`
 * paginated 200 at a time, which is why `limit` is capped rather than optional.
 * Telegram also decides how much a non-admin may enumerate at all, so a short
 * list is a normal answer, not an error — `truncated` says which it was.
 */
export async function getParticipants(
  client: TelegramClient,
  chat: string,
  opts: { limit?: number; search?: string } = {},
): Promise<ParticipantsResult> {
  const limit = Math.min(opts.limit ?? 200, MAX_PARTICIPANTS)
  const users = await throttled('getParticipants', () =>
    client.getParticipants(chat, { limit, search: opts.search ?? '' }))

  const members: Participant[] = []
  for (const u of users) {
    if (!u?.id) continue
    let name = ''
    try { name = getDisplayName(u) } catch { /* entity shape not nameable */ }
    members.push({
      peer_id: String(u.id),
      display_name: name,
      username: typeof u.username === 'string' ? u.username : '',
      is_bot: u.bot === true,
      // GramJS flattens participant rows into users; admin/creator rank is not
      // preserved, so the roster records presence and nothing it cannot know.
      status: u.self ? 'self' : 'member',
    })
  }

  const total = (users as unknown as { total?: number }).total ?? members.length
  return { members, total, truncated: total > members.length }
}

/**
 * Telegram's own per-contact note — the field the app labels "only visible to
 * you" in the New Contact dialog.
 *
 * Worth having alongside `tg_people.note` in our database precisely because it
 * is not ours: it shows up on the owner's phone and desktop, next to the person,
 * at the moment he is talking to them. Our note is what the system knows; this
 * one is what he sees.
 *
 * Reachable only since MTProto layer 214; the published GramJS speaks 198, so
 * everything here depends on `scripts/patch-gramjs.mjs` having run.
 */

// --- Avatars ---

/** Where one person's avatar lives on disk, keyed by the photo Telegram has now. */
export function avatarPath(peerId: string, photoId: string): string {
  return resolve(TG_MEDIA_DIR, 'avatars', `${peerId}_${photoId}.jpg`)
}

/**
 * The avatar file for a user, downloading it only the first time.
 *
 * The filename carries the profile photo's own id, not just the person's, so a
 * changed avatar is a different file rather than a stale one — and an unchanged
 * avatar is never fetched twice. That matters because every download is an API
 * call against the same budget as everything else, and a profile can be read
 * many times a day.
 *
 * Returns null when the person has no photo, or hides it from the owner.
 */
export async function ensureAvatar(client: TelegramClient, user: Api.User): Promise<string | null> {
  const photo = user.photo as { photoId?: unknown } | undefined
  if (!photo || photo.photoId === undefined || photo.photoId === null) return null

  const path = avatarPath(String(user.id), String(photo.photoId))
  if (existsSync(path)) return path

  const data = await throttled('downloadProfilePhoto', () =>
    client.downloadProfilePhoto(user))
  // Telegram answers with an empty buffer rather than an error when the photo
  // is not actually reachable.
  if (!data || data.length === 0) return null

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  return path
}

/** Note text plus whether Telegram considers this person a contact at all. */
export interface ContactNote {
  peer_id: string
  display_name: string
  /** As stored on the contact — the owner's own labelling, not their self-chosen name. */
  first_name: string
  last_name: string
  username: string
  phone: string
  is_contact: boolean
  note: string
  /** Absolute path to the cached avatar, or null when there is none. */
  avatar: string | null
}

/** InputUser, which the contacts API needs and getInputEntity does not return. */
async function inputUserFor(client: TelegramClient, peer: string): Promise<Api.TypeInputUser> {
  const entity = await throttled('contacts.getInputEntity', () => client.getInputEntity(peer))
  return getInputUser(entity)
}

export async function readContactNote(client: TelegramClient, peer: string): Promise<ContactNote | null> {
  const id = await inputUserFor(client, peer)
  const full = await throttled('users.getFullUser', () =>
    client.invoke(new Api.users.GetFullUser({ id })))

  const user = full.users.find(u => u.className === 'User') as Api.User | undefined
  if (!user) return null

  // A missing avatar must not cost the caller the whole profile.
  let avatar: string | null = null
  try {
    avatar = await ensureAvatar(client, user)
  } catch { /* photo unavailable or unwritable cache — the profile still stands */ }

  return {
    peer_id: String(user.id),
    display_name: getDisplayName(user),
    first_name: typeof user.firstName === 'string' ? user.firstName : '',
    last_name: typeof user.lastName === 'string' ? user.lastName : '',
    username: typeof user.username === 'string' ? user.username : '',
    phone: typeof user.phone === 'string' ? user.phone : '',
    is_contact: user.contact === true,
    // TextWithEntities: we keep the plain text and drop formatting, which is
    // what our own note column can hold anyway.
    note: full.fullUser.note?.text ?? '',
    avatar,
  }
}

/**
 * Set or clear the note on an existing contact.
 *
 * Uses the dedicated `contacts.updateContactNote` rather than `addContact`,
 * which would demand first and last name in the same call and so would quietly
 * rename the person if the caller passed anything but their current name.
 *
 * Telegram keeps notes on contacts. For someone who is not one, this fails and
 * the caller has to decide whether adding them is acceptable — that is a
 * visible change to the account, not something to do as a side effect.
 */
export async function writeContactNote(client: TelegramClient, peer: string, note: string): Promise<boolean> {
  const id = await inputUserFor(client, peer)
  const res = await throttled('contacts.updateContactNote', () =>
    client.invoke(new Api.contacts.UpdateContactNote({
      id,
      note: new Api.TextWithEntities({ text: note, entities: [] }),
    })))
  return res === true || (res as unknown as { className?: string })?.className === 'BoolTrue'
}

export interface AddContactResult {
  peer_id: string
  display_name: string
  /** False when Telegram accepted the call but the person still is not a contact. */
  is_contact: boolean
  note: string
}

/**
 * Add someone to the owner's contacts, optionally with the note already set.
 *
 * `sharePhone` is off by default. Turning it on grants that person the owner's
 * phone number even when his privacy settings would hide it — a disclosure, not
 * a convenience, so it is never implied.
 *
 * The name is required by the API and is the owner's label for them: Telegram
 * shows it instead of whatever the person calls themselves.
 */
export async function addContact(
  client: TelegramClient,
  peer: string,
  opts: { firstName: string; lastName?: string; note?: string; sharePhone?: boolean; phone?: string },
): Promise<AddContactResult> {
  const id = await inputUserFor(client, peer)
  const note = opts.note?.trim() ?? ''

  await throttled('contacts.addContact', () =>
    client.invoke(new Api.contacts.AddContact({
      id,
      firstName: opts.firstName,
      lastName: opts.lastName ?? '',
      phone: normalizePhone(opts.phone ?? ''),
      ...(note ? { note: new Api.TextWithEntities({ text: note, entities: [] }) } : {}),
      ...(opts.sharePhone ? { addPhonePrivacyException: true } : {}),
    })))

  // addContact returns Updates, not the user, so the truth about whether it
  // took comes from reading the profile back.
  const after = await readContactNote(client, peer)
  return {
    peer_id: after?.peer_id ?? String(peer),
    display_name: after?.display_name ?? opts.firstName,
    is_contact: after?.is_contact ?? false,
    note: after?.note ?? '',
  }
}

// --- Sharing a contact ---

export interface ContactCard {
  phone: string
  firstName: string
  lastName: string
  /** Goes into the card's NOTE property. Empty means the property is omitted. */
  note: string
  /**
   * Telegram handle, written as a URL.
   *
   * For someone whose number the owner cannot see, this is the only way the
   * recipient can actually reach them — a vCard with a name and nothing else is
   * an address book entry that cannot be used.
   */
  username?: string
  /** Numeric Telegram id — an archival identifier, not a way to reach anyone. */
  telegramId?: string
}

/** RFC 2426 escaping: backslash, comma, semicolon and newline are structural. */
function vcardEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * A vCard for a Telegram contact.
 *
 * The handle is written four ways on purpose, because address books disagree
 * about where a messaging identity lives:
 *
 * - `IMPP` with `X-SERVICE-TYPE=Telegram` and the `x-apple:` scheme is what
 *   Apple Contacts actually writes when it exports a contact with a Telegram
 *   account; it renders as a tappable Telegram row.
 * - `X-SOCIALPROFILE` is the non-standard property Apple and Google both read
 *   for social handles.
 * - A labelled `URL` shows up in every client, tappable, even those that
 *   understand neither of the above.
 * - `NOTE` is the last resort — plain text nobody can fail to display.
 *
 * The `itemN.` grouping is Apple's way of attaching a label to a property; a
 * client that ignores the grouping still reads the property underneath.
 *
 * All of it matters only for a person whose number the owner cannot see. With
 * no phone there is nothing else to reach them by, and a vCard carrying only a
 * name is an address book entry that cannot be used.
 */
export function buildVcard(card: ContactCard): string {
  const full = [card.firstName, card.lastName].filter(Boolean).join(' ')
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${vcardEscape(card.lastName)};${vcardEscape(card.firstName)};;;`,
    `FN:${vcardEscape(full)}`,
  ]
  if (card.phone) lines.push(`TEL;TYPE=cell:${vcardEscape(card.phone)}`)

  if (card.username) {
    const handle = vcardEscape(card.username)
    lines.push(
      `item1.IMPP;X-SERVICE-TYPE=Telegram;type=pref:x-apple:${handle}`,
      'item1.X-ABLabel:Telegram',
      `X-SOCIALPROFILE;type=Telegram:x-apple:${handle}`,
      `item2.URL:https://t.me/${handle}`,
      'item2.X-ABLabel:Telegram',
    )
  }

  // Not usable for messaging on its own — an id without an access hash reaches
  // nobody — but it is the one identifier that survives a handle being changed.
  if (card.telegramId) lines.push(`X-TELEGRAM-ID:${vcardEscape(card.telegramId)}`)

  const noteParts: string[] = []
  if (card.username) noteParts.push(`Telegram: @${card.username} — https://t.me/${card.username}`)
  if (card.note) noteParts.push(card.note)
  if (noteParts.length > 0) lines.push(`NOTE:${vcardEscape(noteParts.join('\n'))}`)

  lines.push('END:VCARD')
  return lines.join('\r\n')
}

/**
 * Send the same person as a .vcf file instead of a contact card.
 *
 * The card cannot exist without a phone number, and someone added one-sidedly
 * never gave one. A vCard sent as a document has no such requirement: the
 * recipient's phone offers to import it into their address book, and the file
 * can carry the things the card has no room for — the Telegram handle as a URL,
 * and a note.
 */
export async function sendVcardFile(
  client: TelegramClient,
  chat: string,
  peer: string,
  opts: { comment?: string; attachNote?: boolean } = {},
): Promise<SentContact> {
  const person = await readContactNote(client, peer)
  if (!person) throw new Error(`Не вдалось прочитати профіль "${peer}"`)

  const comment = opts.comment?.trim() ?? ''
  const attach = opts.attachNote === true && comment.length > 0
  const vcard = buildVcard({
    phone: person.phone,
    firstName: person.first_name || person.display_name,
    lastName: person.last_name,
    note: attach ? comment : '',
    username: person.username,
    telegramId: person.peer_id,
  })

  const data = Buffer.from(vcard, 'utf-8')
  const safeName = (person.display_name || peer).replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'contact'

  const msg = await throttled('sendVcardFile', () => client.sendFile(chat, {
    file: new CustomFile(`${safeName}.vcf`, data.length, '', data),
    caption: comment || undefined,
    // A vCard is a contact to import, not a text to read inline.
    forceDocument: true,
  }))

  return {
    msg_id: msg.id,
    display_name: person.display_name,
    phone_known: person.phone.length > 0,
    note_attached: attach,
  }
}

// --- Adding by phone number ---

/**
 * Digits, with the leading plus Telegram expects and nothing else.
 *
 * People write numbers with spaces, brackets and dashes; Telegram matches on
 * the bare number, and a stray character means the contact silently does not
 * resolve to anyone.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return ''
  return trimmed.startsWith('+') ? `+${digits}` : digits
}

export interface ImportedContact {
  /** Null when the number reached nobody on Telegram. */
  peer_id: string | null
  display_name: string
  phone: string
  imported: boolean
  /** Why it did not take, when it did not. */
  reason: string
}

/**
 * Add a contact by phone number, the way a phone's address book sync does.
 *
 * The only route that produces a contact Telegram considers complete. A contact
 * added by username has no number, and without one it cannot be shared as a
 * contact card at all — `inputMediaContact` is addressed by phone and answers
 * MEDIA_EMPTY otherwise.
 *
 * This uploads the number to Telegram, which is how the matching happens. An
 * unregistered number simply comes back unmatched; nothing is sent to it.
 */
export async function importContactByPhone(
  client: TelegramClient,
  opts: { phone: string; firstName: string; lastName?: string; note?: string },
): Promise<ImportedContact> {
  const phone = normalizePhone(opts.phone)
  if (!phone) throw new Error(`"${opts.phone}" не схоже на номер телефону.`)

  const note = opts.note?.trim() ?? ''
  const res = await throttled('contacts.importContacts', () =>
    client.invoke(new Api.contacts.ImportContacts({
      contacts: [new Api.InputPhoneContact({
        // Our own correlation id for this batch of one; Telegram echoes it back.
        clientId: bigInt(Date.now()),
        phone,
        firstName: opts.firstName,
        lastName: opts.lastName ?? '',
        ...(note ? { note: new Api.TextWithEntities({ text: note, entities: [] }) } : {}),
      })],
    })))

  const user = res.users.find(u => u.className === 'User') as Api.User | undefined
  if (!user || res.imported.length === 0) {
    return {
      peer_id: null,
      display_name: opts.firstName,
      phone,
      imported: false,
      reason: res.retryContacts.length > 0
        ? 'Telegram попросив повторити пізніше — забагато імпортів поспіль.'
        : 'На цьому номері немає акаунта Telegram, або його налаштування приватності не дають знайти себе за номером.',
    }
  }

  return {
    peer_id: String(user.id),
    display_name: getDisplayName(user),
    phone,
    imported: true,
    reason: '',
  }
}

export interface SentContact {
  msg_id: number
  display_name: string
  /**
   * False when Telegram would not tell us the person's number.
   *
   * The card is addressed by phone, so this is the difference between a card
   * the recipient can act on and a name they can only look at.
   */
  phone_known: boolean
  /** Whether the comment was also embedded in the card. */
  note_attached: boolean
}

/**
 * Send someone's contact card from the owner's account.
 *
 * The name on the card is the one the owner gave them, not the one they chose
 * for themselves — that is what a contact is.
 *
 * The private note stays behind. `inputMediaContact` has no field for it, and
 * `comment` is a separate, explicit text meant for the recipient: it rides as
 * the message caption, which clients render next to the card.
 *
 * `attachNote` additionally writes that same comment into the card's vCard, so
 * it follows the contact into the recipient's address book. It is off by
 * default and it embeds the comment rather than any other text, so nothing
 * travels that the recipient cannot also read in the message — text no one can
 * see is text no one agreed to.
 */
export async function sendContact(
  client: TelegramClient,
  chat: string,
  peer: string,
  opts: { comment?: string; attachNote?: boolean } = {},
): Promise<SentContact> {
  const person = await readContactNote(client, peer)
  if (!person) throw new Error(`Не вдалось прочитати профіль "${peer}"`)

  // Картка адресується номером — без нього Telegram відповідає MEDIA_EMPTY, і
  // непорожній vCard цього не рятує (перевірено). Номер ми бачимо не завжди:
  // людина, яку додали в контакти односторонньо, свого номера не давала. Тож
  // це не збій, а нормальний стан, і сказати про нього треба зрозуміло.
  if (!person.phone) {
    const handle = person.username ? ` (@${person.username})` : ''
    throw new Error(
      `${person.display_name}${handle} не має номера, видимого власнику, ` +
      'а картка контакту без номера в Telegram не існує. Надішли файлом (as_file=true) ' +
      'або текстом — ім\'я, @нік і те, що треба пояснити.')
  }

  const comment = opts.comment?.trim() ?? ''
  const attach = opts.attachNote === true && comment.length > 0
  const card: ContactCard = {
    phone: person.phone,
    firstName: person.first_name || person.display_name,
    lastName: person.last_name,
    note: comment,
  }

  const msg = await throttled('sendContact', () => client.sendFile(chat, {
    file: new Api.InputMediaContact({
      phoneNumber: card.phone,
      firstName: card.firstName,
      lastName: card.lastName,
      // Telegram's own share sends an empty vCard; anything else is a choice.
      vcard: attach ? buildVcard(card) : '',
    }),
    caption: comment || undefined,
  }))

  return {
    msg_id: msg.id,
    display_name: person.display_name,
    phone_known: person.phone.length > 0,
    note_attached: attach,
  }
}
