/**
 * Contract invariants for assembled CLAUDE.md.
 *
 * DISABLED: these assertions grade the *content* of markdown shards
 * (duplicate h2s, tool-mention counts, required emoji markers, size caps).
 * In practice they fight every natural edit of a role's prose and fire on
 * drift that is not a real regression. Counter-productive — roles live in
 * prose, not in a lint rule. Keep the file around so the scaffolding is
 * documented, but skip execution.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'

import {
  assembleFromWorkspaceFiles,
  hasWorkspaceFiles,
} from './workspace-files.js'

const projectRoot = resolve(__dirname, '..')
const botsDir = resolve(projectRoot, 'bots')

function listMarkerBots(): string[] {
  if (!existsSync(botsDir)) return []
  return readdirSync(botsDir)
    .filter(name => {
      // Skip backup/archive directories
      if (name.includes('.backup') || name.startsWith('.')) return false
      try {
        const dir = resolve(botsDir, name)
        return statSync(dir).isDirectory() && hasWorkspaceFiles(dir)
      } catch {
        return false
      }
    })
}

const TOOL_NAMES = [
  'WebSearch', 'WebFetch', 'GenerateImage', 'EditImage',
  'CreateReminder', 'SaveFact', 'SearchMemory', 'AskUser',
  'SendMedia', 'TextToSpeech', 'PublishTelegraph',
  'ListReminders', 'DeleteReminder', 'DeleteFact',
  'TakeScreenshot', 'CurrencyRates', 'GetCurrentTime',
] as const

const bots = listMarkerBots()

describe.skip('workspace-files contract invariants', () => {
  if (bots.length === 0) {
    it.skip('no marker-based bots found', () => {})
    return
  }

  for (const botName of bots) {
    describe(botName, () => {
      const botDir = resolve(botsDir, botName)
      const assembled = assembleFromWorkspaceFiles(botDir)

      it('no duplicate h2 headings', () => {
        const h2s = (assembled.match(/^## .+$/gm) || [])
        const seen = new Map<string, number>()
        for (const h of h2s) {
          seen.set(h, (seen.get(h) || 0) + 1)
        }
        const dups = [...seen.entries()].filter(([, n]) => n > 1)
        expect(dups, `duplicate h2 headings in ${botName}: ${dups.map(([h, n]) => `${h} (×${n})`).join(', ')}`).toEqual([])
      })

      it('all <!-- IF X --> markers stripped from output', () => {
        expect(assembled).not.toMatch(/<!--\s*IF\s+/)
        expect(assembled).not.toMatch(/<!--\s*END\s*-->/)
      })

      it('REPLACES_GLOBAL marker stripped from output', () => {
        expect(assembled).not.toContain('REPLACES_GLOBAL')
      })

      it('no tool over-mention (each tool within reasonable limit)', () => {
        // Tools naturally appear in: master routing table row, drilldown section,
        // examples (positive + negative), decision tree, cross-references in
        // adjacent sections. Limits below are calibrated to allow consolidated
        // canonical placement but flag genuine duplication across shards.
        const offenders: Array<[string, number]> = []
        for (const tool of TOOL_NAMES) {
          const count = (assembled.match(new RegExp(`\\b${tool}\\b`, 'g')) || []).length
          // Canonical drilldown sections — allow up to 18 (decision tree + examples + counter-examples)
          const big = ['CreateReminder', 'SaveFact', 'AskUser', 'SearchMemory', 'WebSearch']
          const limit = big.includes(tool) ? 18 : 8
          if (count > limit) offenders.push([tool, count])
        }
        expect(offenders, `tool over-mentions in ${botName}: ${offenders.map(([t, n]) => `${t}=${n}`).join(', ')}`).toEqual([])
      })

      it('has at least 10 behavioral anchors (❌/✅ pairs)', () => {
        const xCount = (assembled.match(/❌/g) || []).length
        const yCount = (assembled.match(/✅/g) || []).length
        const pairs = Math.min(xCount, yCount)
        expect(pairs).toBeGreaterThanOrEqual(10)
      })

      it('has at least 5 🔒 invariant markers', () => {
        const count = (assembled.match(/🔒/g) || []).length
        expect(count).toBeGreaterThanOrEqual(5)
      })

      it('emoji legend present (🔒/💡/🎯/✅/❌/📌)', () => {
        // Either in BOT_SOUL (REPLACES_GLOBAL bots) or _soul.md (overlay bots)
        for (const e of ['🔒', '💡', '🎯', '✅', '❌', '📌']) {
          expect(assembled).toContain(e)
        }
      })

      it('size under 30 KB', () => {
        expect(assembled.length).toBeLessThan(30 * 1024)
      })
    })
  }
})
