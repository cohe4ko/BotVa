import { resolve, dirname, basename, join, relative } from 'path'
import { fileURLToPath } from 'url'
import {
  existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync,
  writeFileSync, copyFileSync, renameSync, unlinkSync
} from 'fs'
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { safeSqliteBackup } from './sqlite.js'
import type { BackupManifest, BackupOptions, RestoreOptions, BackupInfo } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')

function getProjectRoot(): string {
  return PROJECT_ROOT
}

function getBotNames(): string[] {
  const botsDir = resolve(PROJECT_ROOT, 'bots')
  if (!existsSync(botsDir)) return []
  return readdirSync(botsDir)
    .filter(name => !name.startsWith('.') && statSync(resolve(botsDir, name)).isDirectory())
    .sort()
}

function getBackupsDir(outputDir?: string): string {
  return outputDir ?? resolve(PROJECT_ROOT, 'backups')
}

function computeChecksum(filePath: string): string {
  const hash = createHash('sha256')
  const data = readFileSync(filePath)
  hash.update(data)
  return hash.digest('hex')
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Recursively copy directory, using safeSqliteBackup for .db files */
function copyDirWithSqlite(src: string, dest: string): number {
  mkdirSync(dest, { recursive: true })
  let totalSize = 0

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name)
    const destPath = resolve(dest, entry.name)

    if (entry.isDirectory()) {
      totalSize += copyDirWithSqlite(srcPath, destPath)
    } else if (entry.isFile()) {
      // Skip WAL and SHM files — VACUUM INTO produces clean DB
      if (entry.name.endsWith('.db-wal') || entry.name.endsWith('.db-shm')) continue
      // Skip PID files
      if (entry.name.endsWith('.pid')) continue

      if (entry.name.endsWith('.db')) {
        safeSqliteBackup(srcPath, destPath)
      } else {
        mkdirSync(dirname(destPath), { recursive: true })
        copyFileSync(srcPath, destPath)
      }
      totalSize += statSync(destPath).size
    }
  }
  return totalSize
}

function getBotvaVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function getHostname(): string {
  try {
    return execSync('hostname', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function createBackup(options: BackupOptions): BackupInfo {
  const root = getProjectRoot()
  const backupsDir = getBackupsDir(options.outputDir)
  const tmpDir = resolve(backupsDir, '.tmp')

  mkdirSync(backupsDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const namePart = options.type === 'bot' ? `-${options.botName}` : ''
  const archiveName = `botva-${options.type}${namePart}-${ts}.tar.gz`

  // Temp staging directory
  const stageDir = resolve(tmpDir, `stage-${ts}`)
  mkdirSync(stageDir, { recursive: true })

  let totalSize = 0
  const bots: string[] = []

  try {
    if (options.type === 'bot') {
      if (!options.botName) throw new Error('botName required for bot backup')
      const botDir = resolve(root, 'bots', options.botName)
      if (!existsSync(botDir)) throw new Error(`Bot "${options.botName}" not found`)

      const destBot = resolve(stageDir, 'bot')
      totalSize += copyDirWithSqlite(botDir, destBot)
      bots.push(options.botName)
    } else {
      // System backup: all bots
      const botNames = getBotNames()
      for (const name of botNames) {
        const botDir = resolve(root, 'bots', name)
        const destBot = resolve(stageDir, 'bots', name)
        totalSize += copyDirWithSqlite(botDir, destBot)
        bots.push(name)
      }

      // System configs
      const sysDir = resolve(stageDir, 'system')
      mkdirSync(sysDir, { recursive: true })
      for (const file of ['.env', '.mcp.json', 'mcp-servers.json']) {
        const src = resolve(root, file)
        if (existsSync(src)) {
          copyFileSync(src, resolve(sysDir, file))
          totalSize += statSync(src).size
        }
      }

      // Workspace
      const wsDir = resolve(root, 'workspace')
      if (existsSync(wsDir)) {
        const destWs = resolve(stageDir, 'workspace')
        totalSize += copyDirWithSqlite(wsDir, destWs)
      }
    }

    // Write manifest (without checksum — will update after tar)
    const manifest: BackupManifest = {
      version: 1,
      type: options.type,
      ...(options.botName ? { botName: options.botName } : {}),
      createdAt: new Date().toISOString(),
      hostname: getHostname(),
      botvaVersion: getBotvaVersion(),
      checksum: '',
      bots,
      totalSize,
    }
    writeFileSync(resolve(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

    // Create tar.gz
    const archivePath = resolve(backupsDir, archiveName)
    execSync(`tar -czf "${archivePath}" -C "${stageDir}" .`, { timeout: 120000 })

    // Compute checksum and update manifest
    const checksum = computeChecksum(archivePath)
    manifest.checksum = checksum
    writeFileSync(resolve(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

    // Re-create tar with final manifest
    execSync(`tar -czf "${archivePath}" -C "${stageDir}" .`, { timeout: 120000 })

    const archiveSize = statSync(archivePath).size

    return {
      filename: archiveName,
      path: archivePath,
      manifest,
      sizeBytes: archiveSize,
      createdAt: new Date(manifest.createdAt),
    }
  } finally {
    // Cleanup temp
    rmSync(stageDir, { recursive: true, force: true })
    // Remove .tmp if empty
    try {
      const remaining = readdirSync(tmpDir)
      if (remaining.length === 0) rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

export async function restoreBackup(options: RestoreOptions): Promise<{ restored: string[]; warnings: string[] }> {
  const root = getProjectRoot()
  const archivePath = resolve(options.archivePath)

  if (!existsSync(archivePath)) throw new Error(`Backup file not found: ${archivePath}`)

  // Read manifest from archive
  const manifest = readManifest(archivePath)
  const restored: string[] = []
  const warnings: string[] = []

  if (options.dryRun) {
    // List contents
    const contents = execSync(`tar -tzf "${archivePath}"`, { encoding: 'utf-8', timeout: 30000 })
    return { restored: contents.trim().split('\n'), warnings: ['dry-run: no files extracted'] }
  }

  // Extract to temp dir first
  const tmpDir = resolve(root, 'backups', '.tmp', `restore-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })

  try {
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { timeout: 120000 })

    if (manifest.type === 'bot') {
      const srcBot = resolve(tmpDir, 'bot')
      const targetName = options.targetBotName ?? manifest.botName ?? manifest.bots[0]
      if (!targetName) throw new Error('Cannot determine bot name for restore')

      const destBot = resolve(root, 'bots', targetName)

      if (existsSync(destBot) && !options.overwrite) {
        throw new Error(`Bot "${targetName}" already exists. Use --overwrite to replace.`)
      }

      if (existsSync(destBot)) {
        // Stop bot before overwriting
        try {
          const { stopBot } = await import('../admin/bot-control.js')
          stopBot(targetName)
        } catch { /* may not be running */ }
        rmSync(destBot, { recursive: true, force: true })
      }

      mkdirSync(dirname(destBot), { recursive: true })
      renameSync(srcBot, destBot)
      restored.push(`bots/${targetName}/`)

    } else {
      // System restore
      // Restore bots
      const srcBots = resolve(tmpDir, 'bots')
      if (existsSync(srcBots)) {
        for (const botName of readdirSync(srcBots)) {
          const destBot = resolve(root, 'bots', botName)
          if (existsSync(destBot) && !options.overwrite) {
            warnings.push(`Skipped bot "${botName}" — already exists (use --overwrite)`)
            continue
          }
          if (existsSync(destBot)) {
            try {
              const { stopBot } = await import('../admin/bot-control.js')
              stopBot(botName)
            } catch { /* ignore */ }
            rmSync(destBot, { recursive: true, force: true })
          }
          mkdirSync(dirname(destBot), { recursive: true })
          renameSync(resolve(srcBots, botName), destBot)
          restored.push(`bots/${botName}/`)
        }
      }

      // Restore system configs
      const srcSys = resolve(tmpDir, 'system')
      if (existsSync(srcSys)) {
        for (const file of ['.env', '.mcp.json', 'mcp-servers.json']) {
          const src = resolve(srcSys, file)
          if (existsSync(src)) {
            const dest = resolve(root, file)
            if (existsSync(dest) && !options.overwrite) {
              warnings.push(`Skipped ${file} — already exists (use --overwrite)`)
              continue
            }
            copyFileSync(src, dest)
            restored.push(file)
          }
        }
      }

      // Restore workspace
      const srcWs = resolve(tmpDir, 'workspace')
      if (existsSync(srcWs)) {
        const destWs = resolve(root, 'workspace')
        mkdirSync(destWs, { recursive: true })
        // Merge workspace files (don't delete existing)
        copyDirSimple(srcWs, destWs)
        restored.push('workspace/')
      }
    }

    return { restored, warnings }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Simple recursive copy (no SQLite special handling, used for restore) */
function copyDirSimple(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name)
    const destPath = resolve(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSimple(srcPath, destPath)
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath)
    }
  }
}

export function readManifest(archivePath: string): BackupManifest {
  const output = execSync(
    `tar -xzf "${archivePath}" -O ./manifest.json 2>/dev/null || tar -xzf "${archivePath}" -O manifest.json`,
    { encoding: 'utf-8', timeout: 30000 }
  )
  return JSON.parse(output)
}

export function verifyBackup(archivePath: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!existsSync(archivePath)) {
    return { valid: false, errors: ['File not found'] }
  }

  try {
    const manifest = readManifest(archivePath)

    if (manifest.version !== 1) {
      errors.push(`Unknown manifest version: ${manifest.version}`)
    }

    if (!manifest.checksum) {
      errors.push('No checksum in manifest')
    }

    // Verify archive integrity
    execSync(`tar -tzf "${archivePath}" > /dev/null`, { timeout: 30000 })
  } catch (err) {
    errors.push(`Archive verification failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { valid: errors.length === 0, errors }
}

export function listBackups(dir?: string): BackupInfo[] {
  const backupsDir = getBackupsDir(dir)
  if (!existsSync(backupsDir)) return []

  const files = readdirSync(backupsDir)
    .filter(f => f.startsWith('botva-') && f.endsWith('.tar.gz'))
    .sort()
    .reverse()

  const results: BackupInfo[] = []
  for (const filename of files) {
    const filePath = resolve(backupsDir, filename)
    try {
      const manifest = readManifest(filePath)
      const stat = statSync(filePath)
      results.push({
        filename,
        path: filePath,
        manifest,
        sizeBytes: stat.size,
        createdAt: new Date(manifest.createdAt),
      })
    } catch {
      // Skip corrupted backups
    }
  }
  return results
}

export function deleteBackup(filename: string, dir?: string): boolean {
  const backupsDir = getBackupsDir(dir)
  const filePath = resolve(backupsDir, filename)

  // Safety: only delete files that look like backups
  if (!filename.startsWith('botva-') || !filename.endsWith('.tar.gz')) return false
  if (!existsSync(filePath)) return false

  unlinkSync(filePath)
  return true
}

export { formatSize, getProjectRoot, getBotNames, getBackupsDir }
