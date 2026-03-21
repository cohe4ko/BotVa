import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  collectPendingFacts,
  getNextPendingFact,
  reviewFact,
  getReviewStats,
  getFactsForDate,
  getFactById,
} from './listener-facts.js'

const TEST_ROOT = join(tmpdir(), `listener-facts-test-${Date.now()}`)
const LISTENER_DIR = join(TEST_ROOT, 'workspace', 'listener')
const ANALYZED_DIR = join(LISTENER_DIR, 'analyzed')

function writeAnalyzed(date: string, ts: string, data: any) {
  const dir = join(ANALYZED_DIR, date)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${ts}.json`), JSON.stringify(data))
}

beforeEach(() => {
  mkdirSync(LISTENER_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('collectPendingFacts', () => {
  it('creates pending items from analyzed files', () => {
    writeAnalyzed('2026-03-19', '2026-03-19T20-50-14', {
      timestamp: '2026-03-19T20-50-14',
      device: 'opi-test',
      text: 'some text',
      facts: ['Doctor appointment on Friday'],
      decisions: ['Decided to sell the car'],
      tasks: [],
      topics: ['health'],
      summary: 'test',
      language: 'uk',
    })

    const added = collectPendingFacts(TEST_ROOT)
    expect(added).toBe(2) // 1 fact + 1 decision

    const stats = getReviewStats(TEST_ROOT)
    expect(stats.pending).toBe(2)
    expect(stats.approved).toBe(0)
    expect(stats.declined).toBe(0)
  })

  it('does not duplicate on second call', () => {
    writeAnalyzed('2026-03-19', '2026-03-19T20-50-14', {
      timestamp: '2026-03-19T20-50-14',
      device: 'opi-test',
      text: 'test',
      facts: ['Fact 1'],
      decisions: [],
      tasks: [],
      topics: [],
      summary: 'test',
      language: 'uk',
    })

    collectPendingFacts(TEST_ROOT)
    const added2 = collectPendingFacts(TEST_ROOT)
    expect(added2).toBe(0)

    const stats = getReviewStats(TEST_ROOT)
    expect(stats.pending).toBe(1)
  })

  it('returns 0 when no analyzed files exist', () => {
    const added = collectPendingFacts(TEST_ROOT)
    expect(added).toBe(0)
  })
})

describe('getNextPendingFact', () => {
  it('returns first pending item', () => {
    writeAnalyzed('2026-03-19', '2026-03-19T20-50-14', {
      timestamp: '2026-03-19T20-50-14',
      device: 'opi-test',
      text: 'test',
      facts: ['Fact A', 'Fact B'],
      decisions: [],
      tasks: [],
      topics: ['work'],
      summary: 'test',
      language: 'uk',
    })

    collectPendingFacts(TEST_ROOT)
    const next = getNextPendingFact(TEST_ROOT)
    expect(next).not.toBeNull()
    expect(next!.content).toBe('Fact A')
    expect(next!.type).toBe('fact')
    expect(next!.device).toBe('opi-test')
    expect(next!.topics).toEqual(['work'])
  })

  it('returns null when no pending facts', () => {
    const next = getNextPendingFact(TEST_ROOT)
    expect(next).toBeNull()
  })
})

describe('reviewFact', () => {
  it('approves a fact', () => {
    writeAnalyzed('2026-03-19', '2026-03-19T20-50-14', {
      timestamp: '2026-03-19T20-50-14',
      device: 'opi-test',
      text: 'test',
      facts: ['Important fact'],
      decisions: [],
      tasks: [],
      topics: [],
      summary: 'test',
      language: 'uk',
    })

    collectPendingFacts(TEST_ROOT)
    const id = '2026-03-19T20-50-14:fact:0'
    const result = reviewFact(id, 'approved', undefined, TEST_ROOT)
    expect(result).not.toBeNull()
    expect(result!.status).toBe('approved')
    expect(result!.reviewedAt).toBeGreaterThan(0)

    const stats = getReviewStats(TEST_ROOT)
    expect(stats.approved).toBe(1)
    expect(stats.pending).toBe(0)
  })

  it('declines a fact', () => {
    writeAnalyzed('2026-03-19', '2026-03-19T20-50-14', {
      timestamp: '2026-03-19T20-50-14',
      device: 'opi-test',
      text: 'test',
      facts: ['Irrelevant fact'],
      decisions: [],
      tasks: [],
      topics: [],
      summary: 'test',
      language: 'uk',
    })

    collectPendingFacts(TEST_ROOT)
    const result = reviewFact('2026-03-19T20-50-14:fact:0', 'declined', undefined, TEST_ROOT)
    expect(result!.status).toBe('declined')
  })

  it('returns null for unknown id', () => {
    const result = reviewFact('nonexistent:fact:0', 'approved', undefined, TEST_ROOT)
    expect(result).toBeNull()
  })
})

describe('getFactsForDate', () => {
  it('returns items for specific date', () => {
    writeAnalyzed('2026-03-19', '2026-03-19T20-50-14', {
      timestamp: '2026-03-19T20-50-14',
      device: 'opi-test',
      text: 'test',
      facts: ['Fact 1'],
      decisions: [],
      tasks: [],
      topics: [],
      summary: 'test',
      language: 'uk',
    })
    writeAnalyzed('2026-03-20', '2026-03-20T10-00-00', {
      timestamp: '2026-03-20T10-00-00',
      device: 'opi-test',
      text: 'test2',
      facts: ['Fact 2'],
      decisions: [],
      tasks: [],
      topics: [],
      summary: 'test2',
      language: 'uk',
    })

    collectPendingFacts(TEST_ROOT)
    const day19 = getFactsForDate('2026-03-19', TEST_ROOT)
    const day20 = getFactsForDate('2026-03-20', TEST_ROOT)
    expect(day19).toHaveLength(1)
    expect(day20).toHaveLength(1)
    expect(day19[0].content).toBe('Fact 1')
    expect(day20[0].content).toBe('Fact 2')
  })
})

describe('Tinder flow', () => {
  it('processes facts one by one', () => {
    writeAnalyzed('2026-03-19', '2026-03-19T20-50-14', {
      timestamp: '2026-03-19T20-50-14',
      device: 'opi-test',
      text: 'test',
      facts: ['Fact A', 'Fact B'],
      decisions: ['Decision C'],
      tasks: [],
      topics: ['health'],
      summary: 'test',
      language: 'uk',
    })

    collectPendingFacts(TEST_ROOT)

    // Review first
    const first = getNextPendingFact(TEST_ROOT)
    expect(first!.content).toBe('Fact A')
    reviewFact(first!.id, 'approved', undefined, TEST_ROOT)

    // Review second
    const second = getNextPendingFact(TEST_ROOT)
    expect(second!.content).toBe('Fact B')
    reviewFact(second!.id, 'declined', undefined, TEST_ROOT)

    // Review third
    const third = getNextPendingFact(TEST_ROOT)
    expect(third!.content).toBe('Decision C')
    expect(third!.type).toBe('decision')
    reviewFact(third!.id, 'approved', undefined, TEST_ROOT)

    // No more
    const none = getNextPendingFact(TEST_ROOT)
    expect(none).toBeNull()

    const stats = getReviewStats(TEST_ROOT)
    expect(stats).toEqual({ pending: 0, approved: 2, declined: 1 })
  })
})
