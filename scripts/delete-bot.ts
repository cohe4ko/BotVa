#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { resolve } from 'path'
import { createBackup } from '../src/backup/engine.js'

const ROOT = resolve(import.meta.dirname, '..')
const BOTS_DIR = resolve(ROOT, 'bots')
const TEAM_JSON = resolve(ROOT, 'workspace/team.json')

function main() {
  const args = process.argv.slice(2)
  const slug = args[0]

  if (!slug || slug === '--help' || slug === '-h') {
    console.log(`
Usage: npm run delete-bot -- <bot-name>

Creates a backup in backups/ then deletes the bot.
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

  // Backup
  console.log(`Backing up ${slug}...`)
  const info = createBackup({ type: 'bot', botName: slug })
  console.log(`  Saved to backups/${info.filename}`)

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
  console.log(`To restore: ./scripts/deploy.sh restore backups/${info.filename}`)
}

main()
