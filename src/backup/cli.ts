import { parseArgs } from 'node:util'
import { createBackup, restoreBackup, listBackups, verifyBackup, formatSize } from './engine.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bot: { type: 'string' },
    system: { type: 'boolean', default: false },
    'bot-name': { type: 'string' },
    overwrite: { type: 'boolean', default: false },
  },
})

const command = positionals[0]

function green(s: string) { return `\x1b[32m${s}\x1b[0m` }
function red(s: string) { return `\x1b[31m${s}\x1b[0m` }
function bold(s: string) { return `\x1b[1m${s}\x1b[0m` }

async function main() {
  switch (command) {
    case 'backup': {
      const type = values.bot ? 'bot' as const : 'system' as const
      const botName = values.bot

      if (type === 'bot' && !botName) {
        console.error(red('✗ --bot <name> is required for bot backup'))
        process.exit(1)
      }

      console.log(`Creating ${type} backup${botName ? ` for ${botName}` : ''}...`)
      const info = createBackup({ type, botName })
      console.log(green(`✓ Backup created: ${info.filename}`))
      console.log(`  Size: ${formatSize(info.sizeBytes)}`)
      console.log(`  Bots: ${info.manifest.bots.join(', ')}`)
      console.log(`  Path: ${info.path}`)
      break
    }

    case 'restore': {
      const archivePath = positionals[1]
      if (!archivePath) {
        console.error(red('✗ Usage: restore <backup-file> [--bot-name <name>] [--overwrite]'))
        process.exit(1)
      }

      console.log(`Restoring from ${archivePath}...`)
      const result = await restoreBackup({
        archivePath,
        targetBotName: values['bot-name'],
        overwrite: values.overwrite,
      })

      for (const w of result.warnings) console.log(`  ! ${w}`)
      for (const r of result.restored) console.log(green(`  ✓ ${r}`))
      console.log(green(`✓ Restore complete (${result.restored.length} items)`))
      break
    }

    case 'list': {
      const backups = listBackups()
      if (backups.length === 0) {
        console.log('No backups found.')
        break
      }

      console.log(bold('Backups:\n'))
      console.log(`  ${'Date'.padEnd(22)} ${'Type'.padEnd(8)} ${'Bots'.padEnd(20)} ${'Size'.padEnd(10)} Filename`)
      console.log(`  ${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(20)} ${'─'.repeat(10)} ${'─'.repeat(30)}`)

      for (const b of backups) {
        const date = b.createdAt.toISOString().replace('T', ' ').slice(0, 19)
        const bots = b.manifest.bots.join(', ')
        console.log(`  ${date.padEnd(22)} ${b.manifest.type.padEnd(8)} ${bots.padEnd(20)} ${formatSize(b.sizeBytes).padEnd(10)} ${b.filename}`)
      }
      console.log(`\n  Total: ${backups.length} backup(s)`)
      break
    }

    case 'verify': {
      const filePath = positionals[1]
      if (!filePath) {
        console.error(red('✗ Usage: verify <backup-file>'))
        process.exit(1)
      }

      console.log(`Verifying ${filePath}...`)
      const result = verifyBackup(filePath)
      if (result.valid) {
        console.log(green('✓ Backup is valid'))
      } else {
        console.log(red('✗ Backup verification failed:'))
        for (const e of result.errors) console.log(`  - ${e}`)
        process.exit(1)
      }
      break
    }

    default:
      console.log('Usage:')
      console.log('  backup --bot <name>           Create bot backup')
      console.log('  backup --system               Create system backup')
      console.log('  restore <file> [--overwrite]   Restore from backup')
      console.log('  list                          List backups')
      console.log('  verify <file>                 Verify backup integrity')
      process.exit(command ? 1 : 0)
  }
}

main().catch(err => {
  console.error(red(`✗ ${err.message}`))
  process.exit(1)
})
