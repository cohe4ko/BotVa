import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'path'
import { mkdirSync } from 'fs'

/**
 * Safe SQLite backup using VACUUM INTO.
 * Creates an atomic, consistent copy regardless of WAL state.
 * Works with concurrent readers — no need to stop the bot.
 */
export function safeSqliteBackup(sourcePath: string, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true })
  const db = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}
