#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

const ROOT = resolve(import.meta.dirname, '..')
const BOTS_DIR = resolve(ROOT, 'bots')
const TEAM_JSON = resolve(ROOT, 'workspace/team.json')
const ARCHIVE_DIR = resolve(ROOT, 'archive')

function main() {
  const args = process.argv.slice(2)
  const slug = args[0]

  if (!slug || slug === '--help' || slug === '-h') {
    console.log(`
Usage: npm run delete-bot -- <bot-name>

Archives the bot folder to archive/ then deletes it.
`)
    process.exit(0)
  }

  const botDir = resolve(BOTS_DIR, slug)
  if (!existsSync(botDir)) {
    console.error(`Error: bot "${slug}" not found at ${botDir}`)
    process.exit(1)
  }

  // Stop bot if running
  const pidFile = resolve(botDir, 'store', 'botva.pid')
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
      if (!isNaN(pid)) {
        process.kill(pid, 'SIGTERM')
        console.log(`  Stopped bot (PID ${pid})`)
      }
    } catch { /* not running */ }
  }

  // Archive
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const archiveName = `${slug}_${ts}.tar.gz`
  const archivePath = resolve(ARCHIVE_DIR, archiveName)

  console.log(`Archiving ${slug}...`)
  execSync(`tar -czf "${archivePath}" -C "${BOTS_DIR}" "${slug}"`, { timeout: 30000 })
  console.log(`  Saved to archive/${archiveName}`)

  // Delete
  rmSync(botDir, { recursive: true, force: true })
  console.log(`  Deleted bots/${slug}/`)

  // Remove from team.json
  if (existsSync(TEAM_JSON)) {
    try {
      const team = JSON.parse(readFileSync(TEAM_JSON, 'utf-8'))
      if (team.bots?.[slug]) {
        delete team.bots[slug]
        writeFileSync(TEAM_JSON, JSON.stringify(team, null, 2) + '\n')
        console.log(`  Removed from workspace/team.json`)
      }
    } catch { /* ignore */ }
  }

  console.log(`\nBot "${slug}" deleted.`)
  console.log(`To restore: tar -xzf archive/${archiveName} -C bots/`)
}

main()
