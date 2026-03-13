import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { spawn } from 'child_process'
import { getBotDir, getProjectRoot, type BotName } from './db-multi.js'

export interface BotStatus {
  name: BotName
  running: boolean
  pid: number | null
}

function getPidFile(name: BotName): string {
  return resolve(getBotDir(name), 'store', 'botva.pid')
}

function readPid(name: BotName): number | null {
  const pidFile = getPidFile(name)
  if (!existsSync(pidFile)) return null
  const raw = readFileSync(pidFile, 'utf-8').trim()
  const pid = parseInt(raw, 10)
  return isNaN(pid) ? null : pid
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function getBotStatus(name: BotName): BotStatus {
  const pid = readPid(name)
  const running = pid !== null && isAlive(pid)
  return { name, running, pid: running ? pid : null }
}

export function getBotUptime(name: BotName): string | null {
  const pidFile = getPidFile(name)
  if (!existsSync(pidFile)) return null
  const pid = readPid(name)
  if (pid === null || !isAlive(pid)) return null
  try {
    const mtime = statSync(pidFile).mtimeMs
    const uptimeMs = Date.now() - mtime
    const hours = Math.floor(uptimeMs / 3600000)
    const mins = Math.floor((uptimeMs % 3600000) / 60000)
    if (hours > 24) {
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h`
    }
    return `${hours}h ${mins}m`
  } catch { return null }
}

export function stopBot(name: BotName): boolean {
  const pid = readPid(name)
  if (pid === null || !isAlive(pid)) return false
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

export function isSelf(name: BotName): boolean {
  const pid = readPid(name)
  return pid === process.pid
}

function spawnBot(name: BotName): void {
  const root = getProjectRoot()
  const child = spawn('node', ['dist/index.js'], {
    cwd: root,
    env: { ...process.env, BOT_NAME: name },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

export function startBot(name: BotName): boolean {
  const status = getBotStatus(name)
  if (status.running) return false
  spawnBot(name)
  return true
}

export async function restartBot(name: BotName): Promise<boolean> {
  if (isSelf(name)) {
    // Restarting our own process: spawn replacement and let it kill us via acquireLock()
    spawnBot(name)
    return true
  }

  stopBot(name)
  // Wait for process to die
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const pid = readPid(name)
    if (pid === null || !isAlive(pid)) break
    await new Promise(r => setTimeout(r, 200))
  }
  return startBot(name)
}
