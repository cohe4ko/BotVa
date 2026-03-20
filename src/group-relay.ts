/**
 * Group relay: enables bot-to-bot communication in Telegram group chats.
 *
 * Telegram blocks bots from seeing other bots' messages. This module
 * provides a file-based relay: when a bot sends a group message, it writes
 * to a shared JSONL file. Other bots poll this file and process new messages.
 *
 * Relay file: store/group-relay/<chatId>.jsonl
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT, BOT_NAME } from './config.js'
import { logger } from './logger.js'

const RELAY_DIR = resolve(PROJECT_ROOT, 'store', 'group-relay')
const POLL_INTERVAL_MS = 2_000

export interface RelayMessage {
  ts: number
  chatId: string
  botName: string
  botUsername: string
  text: string
}

// Track file read position per chat
const filePositions = new Map<string, number>()

// Ensure relay directory exists
function ensureRelayDir(): void {
  if (!existsSync(RELAY_DIR)) {
    mkdirSync(RELAY_DIR, { recursive: true })
  }
}

function relayPath(chatId: string): string {
  return resolve(RELAY_DIR, `${chatId}.jsonl`)
}

/**
 * Write a message to the relay file (called after sending to Telegram).
 */
export function relayWrite(chatId: string, botUsername: string, text: string): void {
  ensureRelayDir()
  const msg: RelayMessage = {
    ts: Date.now(),
    chatId,
    botName: BOT_NAME,
    botUsername,
    text,
  }
  try {
    appendFileSync(relayPath(chatId), JSON.stringify(msg) + '\n')
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to write relay message')
  }
}

/**
 * Read new messages from the relay file for a given chat.
 * Returns only messages from OTHER bots (not self).
 */
function relayRead(chatId: string): RelayMessage[] {
  const path = relayPath(chatId)
  if (!existsSync(path)) return []

  let fileSize: number
  try {
    fileSize = statSync(path).size
  } catch {
    return []
  }

  const pos = filePositions.get(chatId) ?? 0
  if (fileSize <= pos) return []

  try {
    // Read only new bytes (pos is byte offset, not character offset)
    const bytesToRead = fileSize - pos
    const buf = Buffer.alloc(bytesToRead)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, bytesToRead, pos)
    } finally {
      closeSync(fd)
    }
    filePositions.set(chatId, fileSize)

    const newContent = buf.toString('utf-8')
    const newLines = newContent.split('\n').filter(Boolean)
    const messages: RelayMessage[] = []

    for (const line of newLines) {
      try {
        const msg: RelayMessage = JSON.parse(line)
        // Only process messages from OTHER bots
        if (msg.botName !== BOT_NAME) {
          messages.push(msg)
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to read relay file')
    return []
  }
}

/**
 * Initialize file positions to current file sizes (skip existing messages on startup).
 */
function initFilePositions(chatIds: string[]): void {
  ensureRelayDir()
  for (const chatId of chatIds) {
    const path = relayPath(chatId)
    if (existsSync(path)) {
      try {
        filePositions.set(chatId, statSync(path).size)
      } catch {
        filePositions.set(chatId, 0)
      }
    }
  }
}

/**
 * Start polling relay files for new messages from other bots.
 * @param chatIdsOrFn - list of group chat IDs or a function returning them (for dynamic groups)
 * @param onMessage - callback when a new message from another bot arrives
 */
export function startRelayPoller(
  chatIdsOrFn: string[] | (() => string[]),
  onMessage: (msg: RelayMessage) => void
): () => void {
  const getChatIds = typeof chatIdsOrFn === 'function' ? chatIdsOrFn : () => chatIdsOrFn
  const knownChatIds = new Set<string>()

  const initial = getChatIds()
  initFilePositions(initial)
  initial.forEach(id => knownChatIds.add(id))

  const timer = setInterval(() => {
    const currentIds = getChatIds()
    // Init positions for newly added groups
    for (const id of currentIds) {
      if (!knownChatIds.has(id)) {
        initFilePositions([id])
        knownChatIds.add(id)
      }
    }
    for (const chatId of currentIds) {
      const messages = relayRead(chatId)
      for (const msg of messages) {
        logger.info({ chatId, from: msg.botName, textLen: msg.text.length }, 'Relay message received')
        onMessage(msg)
      }
    }
  }, POLL_INTERVAL_MS)

  logger.info({ chatIds: initial, interval: POLL_INTERVAL_MS }, 'Relay poller started')

  return () => clearInterval(timer)
}

/**
 * Clear relay file for a chat (called on /stop).
 */
export function relayClear(chatId: string): void {
  const path = relayPath(chatId)
  try {
    if (existsSync(path)) {
      appendFileSync(path, '') // keep file, just update position
      filePositions.set(chatId, statSync(path).size)
    }
  } catch {
    // ignore
  }
}
