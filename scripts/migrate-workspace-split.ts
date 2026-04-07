#!/usr/bin/env tsx
/**
 * One-off migration: split per-bot workspace-files into global (virtual, in roles/)
 * and per-bot (on-disk) layers, per the workspace-files refactor.
 *
 * For each bot in bots/<name>/workspace-files/:
 *   - Strip roles/_tools.md prefix from TOOLS.md → BOT_TOOLS.md (residual is role-specific)
 *   - Diff SOUL.md vs roles/_soul.md → BOT_SOUL.md (only if differs)
 *   - Delete on-disk SOUL.md and TOOLS.md (they become virtual)
 *
 * Bots without IDENTITY.md (legacy / non-marker) are skipped.
 *
 * Run:  tsx scripts/migrate-workspace-split.ts [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, cpSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const botsDir = resolve(projectRoot, 'bots')
const rolesDir = resolve(projectRoot, 'roles')

const dryRun = process.argv.includes('--dry-run')

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\s+$/gm, '').trim()
}

/**
 * Find role-specific tail in `current` by comparing against `base` line-by-line.
 * Strategy: locate the LAST line of base inside current. Everything after that
 * line is treated as role-specific. If base content has drifted, fall back to
 * substring of base's last non-trivial line (>=20 chars). If still not found,
 * return null (caller decides fallback).
 */
function extractRoleTail(current: string, base: string): string | null {
  if (!base.trim()) return null
  const baseLines = base.split('\n').map(l => l.trimEnd()).filter(l => l.length >= 20)
  // Try anchors from the end of base, walking backwards
  for (let i = baseLines.length - 1; i >= Math.max(0, baseLines.length - 20); i--) {
    const anchor = baseLines[i]
    const idx = current.indexOf(anchor)
    if (idx !== -1) {
      const afterAnchor = current.slice(idx + anchor.length)
      // Skip the rest of the line + leading whitespace
      const newlineIdx = afterAnchor.indexOf('\n')
      if (newlineIdx === -1) return ''
      return afterAnchor.slice(newlineIdx + 1).replace(/^\s+/, '').replace(/\s+$/, '')
    }
  }
  return null
}

function migrateBot(name: string): { skipped?: string; result?: string } {
  const wsDir = resolve(botsDir, name, 'workspace-files')
  if (!existsSync(wsDir)) return { skipped: 'no workspace-files dir' }

  const identityPath = resolve(wsDir, 'IDENTITY.md')
  if (!existsSync(identityPath)) return { skipped: 'no IDENTITY.md (legacy bot)' }

  const toolsPath = resolve(wsDir, 'TOOLS.md')
  const soulPath = resolve(wsDir, 'SOUL.md')
  const botToolsPath = resolve(wsDir, 'BOT_TOOLS.md')
  const botSoulPath = resolve(wsDir, 'BOT_SOUL.md')

  const baseTools = existsSync(resolve(rolesDir, '_tools.md'))
    ? readFileSync(resolve(rolesDir, '_tools.md'), 'utf-8')
    : ''
  const baseSoul = existsSync(resolve(rolesDir, '_soul.md'))
    ? readFileSync(resolve(rolesDir, '_soul.md'), 'utf-8')
    : ''

  let botToolsContent = ''
  let botSoulContent = ''

  // --- TOOLS.md → BOT_TOOLS.md ---
  if (existsSync(toolsPath)) {
    const current = readFileSync(toolsPath, 'utf-8')
    const currentNorm = normalize(current)
    const baseNorm = normalize(baseTools)
    if (baseNorm && currentNorm.startsWith(baseNorm)) {
      // Exact prefix match — clean strip
      botToolsContent = current.slice(current.indexOf(baseNorm) + baseNorm.length).replace(/^\s+/, '')
    } else {
      // Drifted base — try anchor-based extraction
      const tail = extractRoleTail(current, baseTools)
      if (tail !== null) {
        botToolsContent = tail
      } else {
        // Hopeless — keep entire content (will dup with global, user can prune)
        botToolsContent = current
      }
    }
  }

  // --- SOUL.md → BOT_SOUL.md ---
  if (existsSync(soulPath)) {
    const current = readFileSync(soulPath, 'utf-8')
    if (normalize(current) === normalize(baseSoul)) {
      // Identical to global → empty BOT_SOUL with hint
      botSoulContent = ''
    } else {
      // Differs → preserve entire content (admin can curate later)
      botSoulContent = current
    }
  }

  const summary = {
    botTools: botToolsContent.trim().length,
    botSoul: botSoulContent.trim().length,
    deleted: [] as string[],
  }

  if (dryRun) {
    return {
      result: `BOT_TOOLS=${summary.botTools}b, BOT_SOUL=${summary.botSoul}b, would delete: ${
        existsSync(toolsPath) ? 'TOOLS.md ' : ''
      }${existsSync(soulPath) ? 'SOUL.md' : ''}`,
    }
  }

  // Write per-bot files
  if (botToolsContent.trim()) {
    writeFileSync(botToolsPath, botToolsContent.trim() + '\n', 'utf-8')
  } else if (!existsSync(botToolsPath)) {
    writeFileSync(botToolsPath, '', 'utf-8')
  }

  if (botSoulContent.trim()) {
    writeFileSync(botSoulPath, botSoulContent.trim() + '\n', 'utf-8')
  } else if (!existsSync(botSoulPath)) {
    writeFileSync(
      botSoulPath,
      '<!-- BOT_SOUL.md — per-bot soul overlay. Empty by default. Add personal nuances here. -->\n',
      'utf-8'
    )
  }

  // Delete now-virtual files
  if (existsSync(toolsPath)) {
    unlinkSync(toolsPath)
    summary.deleted.push('TOOLS.md')
  }
  if (existsSync(soulPath)) {
    unlinkSync(soulPath)
    summary.deleted.push('SOUL.md')
  }

  return {
    result: `BOT_TOOLS=${summary.botTools}b, BOT_SOUL=${summary.botSoul}b, deleted: ${summary.deleted.join(', ') || 'none'}`,
  }
}

// --- main ---

if (!existsSync(botsDir)) {
  console.error(`No bots/ directory at ${botsDir}`)
  process.exit(1)
}

if (!dryRun) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = resolve(projectRoot, `bots.backup-${ts}`)
  console.log(`Backing up bots/ → ${backup}`)
  cpSync(botsDir, backup, { recursive: true })
}

const bots = readdirSync(botsDir).filter(name => {
  try {
    return statSync(resolve(botsDir, name)).isDirectory()
  } catch {
    return false
  }
})

console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Migrating ${bots.length} bots:\n`)
for (const name of bots) {
  const { skipped, result } = migrateBot(name)
  if (skipped) {
    console.log(`  - ${name}: SKIP (${skipped})`)
  } else {
    console.log(`  - ${name}: ${result}`)
  }
}
console.log(dryRun ? '\n[DRY RUN] No files modified.' : '\nDone.')
