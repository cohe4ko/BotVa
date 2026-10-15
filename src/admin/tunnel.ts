/**
 * A temporary public address for the admin panel — for a machine behind NAT,
 * a firewall or a changing IP, with nothing to configure.
 *
 * The tunnel is an outgoing connection, so it works wherever the machine can
 * reach the internet. Two providers, neither needing an account:
 * - Cloudflare Quick Tunnel, when `cloudflared` is installed (steadier);
 * - localhost.run over the system `ssh`, which needs nothing installed.
 *
 * TLS ends at the provider, and the panel includes a terminal, so the tunnel
 * is only ever opened on request ("🌐" button on /admin) and closes with the
 * panel. Access still needs the one-off token in the link.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { logger } from '../logger.js'

export type TunnelProvider = 'cloudflared' | 'localhost.run'

const START_TIMEOUT_MS = 30_000

const URL_PATTERNS: Record<TunnelProvider, RegExp> = {
  'cloudflared': /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
  'localhost.run': /https:\/\/[a-z0-9-]+\.lhr\.life/,
}

/** The public URL a provider prints once the tunnel is up, if this output has it. */
export function parseTunnelUrl(provider: TunnelProvider, output: string): string | undefined {
  return output.match(URL_PATTERNS[provider])?.[0]
}

function hasCommand(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
    return false
  }
}

/** Cloudflare when it is installed, otherwise localhost.run over ssh. */
export function pickProvider(has: (cmd: string) => boolean = hasCommand): TunnelProvider | undefined {
  if (has('cloudflared')) return 'cloudflared'
  if (has('ssh')) return 'localhost.run'
  return undefined
}

export function tunnelCommand(provider: TunnelProvider, port: number, stateDir: string): { cmd: string; args: string[] } {
  if (provider === 'cloudflared') {
    return { cmd: 'cloudflared', args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`] }
  }
  return {
    cmd: 'ssh',
    args: [
      // Own known_hosts: never touch the user's, and accept localhost.run's key on first use
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${join(stateDir, 'tunnel_known_hosts')}`,
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `80:127.0.0.1:${port}`,
      // localhost.run takes any user; "nokey" is its documented keyless one
      '-l', 'nokey',
      'localhost.run',
    ],
  }
}

let current: { child: ChildProcess; url: string; provider: TunnelProvider } | null = null
let exitHookSet = false

export function currentTunnel(): { url: string; provider: TunnelProvider; pid?: number } | null {
  return current ? { url: current.url, provider: current.provider, pid: current.child.pid } : null
}

/**
 * Open a tunnel to `port` and resolve with its public https URL. Reuses the
 * open one. Rejects if no provider is available or none came up in time.
 */
export async function startTunnel(port: number, stateDir: string, spawnFn: typeof spawn = spawn): Promise<{ url: string; provider: TunnelProvider; pid?: number }> {
  if (current && current.child.exitCode === null) return currentTunnel()!
  const provider = pickProvider()
  if (!provider) throw new Error('neither cloudflared nor ssh is available')
  mkdirSync(stateDir, { recursive: true })
  const { cmd, args } = tunnelCommand(provider, port, stateDir)
  const child = spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  const url = await new Promise<string>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${provider}: no address within ${START_TIMEOUT_MS / 1000}s`)) }, START_TIMEOUT_MS)
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-20_000)
      const found = parseTunnelUrl(provider, output)
      if (found) { clearTimeout(timer); resolve(found) }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${provider} exited (${code}): ${output.slice(-300)}`)) })
  })

  current = { child, url, provider }
  // Never leave the tunnel behind when this process exits (restart, crash)
  if (!exitHookSet) { exitHookSet = true; process.once('exit', stopTunnel) }
  child.on('exit', () => {
    if (current?.child === child) {
      logger.info({ provider }, 'Admin tunnel closed')
      current = null
    }
  })
  logger.info({ provider, url }, 'Admin tunnel open')
  return currentTunnel()!
}

export function stopTunnel(): void {
  if (!current) return
  current.child.kill()
  current = null
}
