import { resolve, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import {
  existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync,
  writeFileSync, copyFileSync, renameSync, unlinkSync
} from 'fs'
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
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

/** Checkpoint all SQLite WAL files in a directory tree before tar */
function checkpointDatabases(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      checkpointDatabases(fullPath)
    } else if (entry.isFile() && entry.name.endsWith('.db')) {
      try {
        const db = new DatabaseSync(fullPath)
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        db.close()
      } catch { /* skip non-sqlite files or locked dbs */ }
    }
  }
}

/** Get directory size in bytes via du */
function dirSize(dir: string): number {
  try {
    return parseInt(execSync(`du -sk "${dir}" 2>/dev/null`, { encoding: 'utf-8' }).split('\t')[0], 10) * 1024
  } catch {
    return 0
  }
}

// Directories to exclude from system backup (auto-recreatable)
const SYSTEM_EXCLUDES = [
  'node_modules',
  'dist',
  '.git',
  'backups',
  'mcp-servers/*/build',
  'mcp-servers/*/node_modules',
  'mcp-servers/*/venv',
  'mcp-servers/*/__pycache__',
]

export function createBackup(options: BackupOptions): BackupInfo {
  const root = getProjectRoot()
  const backupsDir = getBackupsDir(options.outputDir)
  mkdirSync(backupsDir, { recursive: true })

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const namePart = options.type === 'bot' ? `-${options.botName}` : ''
  const archiveName = `botva-${options.type}${namePart}-${ts}.tar.gz`
  const archivePath = resolve(backupsDir, archiveName)

  const bots: string[] = []

  if (options.type === 'bot') {
    // --- Single bot backup: tar entire bot directory ---
    if (!options.botName) throw new Error('botName required for bot backup')
    const botDir = resolve(root, 'bots', options.botName)
    if (!existsSync(botDir)) throw new Error(`Bot "${options.botName}" not found`)

    // Checkpoint SQLite before tar
    checkpointDatabases(botDir)
    bots.push(options.botName)

    // Write manifest into bot dir temporarily
    const manifestPath = resolve(botDir, '.backup-manifest.json')
    const manifest: BackupManifest = {
      version: 1,
      type: 'bot',
      botName: options.botName,
      createdAt: new Date().toISOString(),
      hostname: getHostname(),
      botvaVersion: getBotvaVersion(),
      checksum: '',
      bots,
      totalSize: dirSize(botDir),
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    try {
      // tar entire bot directory as-is
      execSync(`tar -czf "${archivePath}" -C "${resolve(root, 'bots')}" "${options.botName}"`, { timeout: 300000 })

      // Compute checksum
      manifest.checksum = computeChecksum(archivePath)
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

      // Re-tar with checksum in manifest
      execSync(`tar -czf "${archivePath}" -C "${resolve(root, 'bots')}" "${options.botName}"`, { timeout: 300000 })
    } finally {
      // Remove temp manifest from bot dir
      try { unlinkSync(manifestPath) } catch { /* ignore */ }
    }

    const archiveSize = statSync(archivePath).size
    return {
      filename: archiveName,
      path: archivePath,
      manifest,
      sizeBytes: archiveSize,
      createdAt: new Date(manifest.createdAt),
    }

  } else {
    // --- System backup: tar entire project directory ---
    // Checkpoint all databases
    checkpointDatabases(resolve(root, 'bots'))
    checkpointDatabases(resolve(root, 'workspace'))
    checkpointDatabases(resolve(root, 'store'))

    bots.push(...getBotNames())

    // Write manifest into project root temporarily
    const manifestPath = resolve(root, '.backup-manifest.json')
    const manifest: BackupManifest = {
      version: 1,
      type: 'system',
      createdAt: new Date().toISOString(),
      hostname: getHostname(),
      botvaVersion: getBotvaVersion(),
      checksum: '',
      bots,
      totalSize: 0,
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    try {
      // Build exclude flags
      const excludeFlags = [
        ...SYSTEM_EXCLUDES.map(e => `--exclude='${e}'`),
        `--exclude='backups'`,
      ].join(' ')

      execSync(`tar -czf "${archivePath}" ${excludeFlags} -C "${dirname(root)}" "${basename(root)}"`, { timeout: 600000 })

      // Compute checksum
      manifest.checksum = computeChecksum(archivePath)
      manifest.totalSize = statSync(archivePath).size
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

      // Re-tar with checksum
      execSync(`tar -czf "${archivePath}" ${excludeFlags} -C "${dirname(root)}" "${basename(root)}"`, { timeout: 600000 })
    } finally {
      try { unlinkSync(manifestPath) } catch { /* ignore */ }
    }

    const archiveSize = statSync(archivePath).size
    return {
      filename: archiveName,
      path: archivePath,
      manifest,
      sizeBytes: archiveSize,
      createdAt: new Date(manifest.createdAt),
    }
  }
}

export async function restoreBackup(options: RestoreOptions): Promise<{ restored: string[]; warnings: string[] }> {
  const root = getProjectRoot()
  const archivePath = resolve(options.archivePath)

  if (!existsSync(archivePath)) throw new Error(`Backup file not found: ${archivePath}`)

  const manifest = readManifest(archivePath)
  const restored: string[] = []
  const warnings: string[] = []

  if (options.dryRun) {
    const contents = execSync(`tar -tzf "${archivePath}"`, { encoding: 'utf-8', timeout: 30000 })
    return { restored: contents.trim().split('\n'), warnings: ['dry-run: no files extracted'] }
  }

  if (manifest.type === 'bot') {
    // Bot backup: archive contains <botName>/ at root
    const srcName = manifest.botName ?? manifest.bots[0]
    const targetName = options.targetBotName ?? srcName
    if (!targetName) throw new Error('Cannot determine bot name for restore')

    const destBot = resolve(root, 'bots', targetName)

    if (existsSync(destBot) && !options.overwrite) {
      throw new Error(`Bot "${targetName}" already exists. Use --overwrite to replace.`)
    }

    // Stop bot before overwriting
    if (existsSync(destBot)) {
      try {
        const { stopBot } = await import('../admin/bot-control.js')
        stopBot(targetName)
      } catch { /* may not be running */ }
      rmSync(destBot, { recursive: true, force: true })
    }

    // Extract bot directory
    mkdirSync(resolve(root, 'bots'), { recursive: true })

    if (targetName === srcName) {
      // Same name — extract directly
      execSync(`tar -xzf "${archivePath}" -C "${resolve(root, 'bots')}"`, { timeout: 300000 })
    } else {
      // Different name — extract to temp, then rename
      const tmpDir = resolve(root, 'backups', '.tmp', `restore-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })
      try {
        execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { timeout: 300000 })
        renameSync(resolve(tmpDir, srcName!), destBot)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    }

    // Clean up temp manifest
    const tempManifest = resolve(destBot, '.backup-manifest.json')
    if (existsSync(tempManifest)) unlinkSync(tempManifest)

    restored.push(`bots/${targetName}/`)

  } else {
    // System backup: archive contains project directory at root
    // Stop all bots first
    for (const botName of manifest.bots) {
      try {
        const { stopBot } = await import('../admin/bot-control.js')
        stopBot(botName)
      } catch { /* ignore */ }
    }

    // Extract over existing project (tar overwrites existing files)
    const tmpDir = resolve(root, 'backups', '.tmp', `restore-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    try {
      execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { timeout: 600000 })

      // Find the extracted project directory
      const extracted = readdirSync(tmpDir).filter(f => statSync(resolve(tmpDir, f)).isDirectory())
      if (extracted.length === 0) throw new Error('Empty backup archive')
      const srcRoot = resolve(tmpDir, extracted[0])

      // Restore data directories
      for (const dir of ['bots', 'workspace', 'store', 'knowledge', 'agents', 'roles']) {
        const srcDir = resolve(srcRoot, dir)
        if (!existsSync(srcDir)) continue
        const destDir = resolve(root, dir)
        if (existsSync(destDir) && !options.overwrite) {
          warnings.push(`Skipped ${dir}/ — already exists (use --overwrite)`)
          continue
        }
        if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
        renameSync(srcDir, destDir)
        restored.push(`${dir}/`)
      }

      // Restore config files
      for (const file of ['.env', '.mcp.json', 'mcp-servers.json']) {
        const src = resolve(srcRoot, file)
        if (!existsSync(src)) continue
        const dest = resolve(root, file)
        if (existsSync(dest) && !options.overwrite) {
          warnings.push(`Skipped ${file} — already exists (use --overwrite)`)
          continue
        }
        copyFileSync(src, dest)
        restored.push(file)
      }

      // Clean up temp manifest
      const tempManifest = resolve(root, '.backup-manifest.json')
      if (existsSync(tempManifest)) unlinkSync(tempManifest)

    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  return { restored, warnings }
}

export function readManifest(archivePath: string): BackupManifest {
  // Try to find manifest in archive (may be at different paths depending on backup type)
  const tryPaths = [
    '.backup-manifest.json',
    '*/\\.backup-manifest.json',
  ]

  // Use tar to list and find the manifest
  const listing = execSync(`tar -tzf "${archivePath}" 2>/dev/null`, { encoding: 'utf-8', timeout: 30000 })
  const manifestFile = listing.split('\n').find(f => f.endsWith('.backup-manifest.json'))

  if (!manifestFile) throw new Error('No manifest found in backup archive')

  const output = execSync(
    `tar -xzf "${archivePath}" -O "${manifestFile}"`,
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

  if (!filename.startsWith('botva-') || !filename.endsWith('.tar.gz')) return false
  if (!existsSync(filePath)) return false

  unlinkSync(filePath)
  return true
}

export { formatSize, getProjectRoot, getBotNames, getBackupsDir }
