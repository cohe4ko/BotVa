/**
 * Listener Facts — collects extracted facts from room listener analyzed files
 * and provides a review queue (Tinder-style: one fact at a time, approve/decline).
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { join, resolve, dirname } from 'path'

// --- Types ---

export type FactReviewStatus = 'pending' | 'approved' | 'declined'
export type FactReviewType = 'fact' | 'decision' | 'task'

export interface FactReviewItem {
  id: string                    // {timestamp}:{type}:{index}
  date: string                  // YYYY-MM-DD
  timestamp: string             // e.g. 2026-03-19T20-50-14
  device: string
  type: FactReviewType
  content: string
  topic: string                 // one-word English topic
  tags: string                  // comma-separated bilingual tags
  topics: string[]              // legacy: chunk-level topics
  status: FactReviewStatus
  reviewedAt: number | null     // unix timestamp
  savedTo?: string              // bot name where fact was saved
}

interface ReviewStore {
  items: FactReviewItem[]
}

// --- Paths ---

function getListenerDir(projectRoot?: string): string {
  const root = projectRoot ?? resolve(import.meta.dirname, '..')
  return join(root, 'workspace', 'listener')
}

function getReviewPath(projectRoot?: string): string {
  return join(getListenerDir(projectRoot), 'fact-reviews.json')
}

// --- Store I/O ---

function loadStore(projectRoot?: string): ReviewStore {
  const path = getReviewPath(projectRoot)
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch { /* ignore corrupt file */ }
  return { items: [] }
}

function saveStore(store: ReviewStore, projectRoot?: string): void {
  const path = getReviewPath(projectRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n')
}

// --- Analyzed file reading ---

interface AnalyzedFile {
  timestamp: string
  device: string
  text: string
  facts: string[]
  decisions: string[]
  tasks: string[]
  topics: string[]
  summary: string
  language: string
}

function readAnalyzedFile(filePath: string): AnalyzedFile | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch { return null }
}

function scanAnalyzedFiles(projectRoot?: string): AnalyzedFile[] {
  const analyzedDir = join(getListenerDir(projectRoot), 'analyzed')
  if (!existsSync(analyzedDir)) return []

  const results: AnalyzedFile[] = []
  const dates = readdirSync(analyzedDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  for (const date of dates) {
    const dateDir = join(analyzedDir, date)
    const files = readdirSync(dateDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const data = readAnalyzedFile(join(dateDir, file))
      if (data) results.push(data)
    }
  }
  return results
}

// --- Core functions ---

/** Scan analyzed files and create pending items for new facts/decisions/tasks */
export function collectPendingFacts(projectRoot?: string): number {
  const store = loadStore(projectRoot)
  const existingIds = new Set(store.items.map(i => i.id))

  const analyzed = scanAnalyzedFiles(projectRoot)
  let added = 0

  for (const file of analyzed) {
    const date = file.timestamp.slice(0, 10)
    const types: { type: FactReviewType; items: any[] }[] = [
      { type: 'fact', items: file.facts ?? [] },
      { type: 'decision', items: file.decisions ?? [] },
      { type: 'task', items: file.tasks ?? [] },
    ]

    for (const { type, items } of types) {
      for (let i = 0; i < items.length; i++) {
        const id = `${file.timestamp}:${type}:${i}`
        if (existingIds.has(id)) continue

        const raw = items[i]
        const isObj = typeof raw === 'object' && raw !== null
        store.items.push({
          id,
          date,
          timestamp: file.timestamp,
          device: file.device ?? 'unknown',
          type,
          content: isObj ? raw.text : raw,
          topic: isObj ? (raw.topic ?? 'general') : (file.topics?.[0] ?? 'general'),
          tags: isObj ? (raw.tags ?? '') : '',
          topics: file.topics ?? [],
          status: 'pending',
          reviewedAt: null,
        })
        existingIds.add(id)
        added++
      }
    }
  }

  if (added > 0) saveStore(store, projectRoot)
  return added
}

/** Get next pending fact for review */
export function getNextPendingFact(
  projectRoot?: string,
  skipIds?: ReadonlySet<string>,
): FactReviewItem | null {
  const store = loadStore(projectRoot)
  return store.items.find(i => i.status === 'pending' && !(skipIds?.has(i.id))) ?? null
}

/** Update fact status */
export function reviewFact(id: string, status: 'approved' | 'declined', savedTo?: string, projectRoot?: string): FactReviewItem | null {
  const store = loadStore(projectRoot)
  const item = store.items.find(i => i.id === id)
  if (!item) return null
  item.status = status
  item.reviewedAt = Math.floor(Date.now() / 1000)
  if (savedTo) item.savedTo = savedTo
  saveStore(store, projectRoot)
  return item
}

/** Get review statistics */
export function getReviewStats(projectRoot?: string): { pending: number; approved: number; declined: number } {
  const store = loadStore(projectRoot)
  let pending = 0, approved = 0, declined = 0
  for (const item of store.items) {
    if (item.status === 'pending') pending++
    else if (item.status === 'approved') approved++
    else declined++
  }
  return { pending, approved, declined }
}

/** Get all items for a specific date (for admin UI) */
export function getFactsForDate(date: string, projectRoot?: string): FactReviewItem[] {
  const store = loadStore(projectRoot)
  return store.items.filter(i => i.date === date)
}

/** Get item by ID */
export function getFactById(id: string, projectRoot?: string): FactReviewItem | null {
  const store = loadStore(projectRoot)
  return store.items.find(i => i.id === id) ?? null
}
