import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { parseTunnelUrl, pickProvider, tunnelCommand, startTunnel, stopTunnel, currentTunnel } from './tunnel.js'

function fakeChild() {
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.pid = 4242
  child.kill = vi.fn(() => { child.exitCode = 0; child.emit('exit', 0) })
  return child
}

afterEach(() => stopTunnel())

describe('parseTunnelUrl', () => {
  it('finds the localhost.run address in its banner', () => {
    expect(parseTunnelUrl('localhost.run', 'abc tunneled with tls termination, https://5334e17.lhr.life\r\n')).toBe('https://5334e17.lhr.life')
  })
  it('finds the Cloudflare quick tunnel address in its log', () => {
    expect(parseTunnelUrl('cloudflared', '|  https://quiet-lake-12.trycloudflare.com  |')).toBe('https://quiet-lake-12.trycloudflare.com')
  })
  it('ignores other links', () => {
    expect(parseTunnelUrl('localhost.run', 'see https://localhost.run/docs/forever-free/')).toBeUndefined()
  })
})

describe('pickProvider', () => {
  it('prefers cloudflared, falls back to ssh, else nothing', () => {
    expect(pickProvider(() => true)).toBe('cloudflared')
    expect(pickProvider(c => c === 'ssh')).toBe('localhost.run')
    expect(pickProvider(() => false)).toBeUndefined()
  })
})

describe('tunnelCommand', () => {
  it('forwards the port and keeps its own known_hosts', () => {
    const { cmd, args } = tunnelCommand('localhost.run', 3000, '/state')
    expect(cmd).toBe('ssh')
    expect(args).toContain('80:127.0.0.1:3000')
    expect(args).toContain('UserKnownHostsFile=/state/tunnel_known_hosts')
    expect(args).toContain('BatchMode=yes')
    expect(tunnelCommand('cloudflared', 3000, '/s').args).toContain('http://127.0.0.1:3000')
  })
})

describe('startTunnel', () => {
  it('resolves with the address the provider prints, and reuses the open tunnel', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child) as any
    const p = startTunnel(3000, '/tmp/botva-tunnel-test', spawnFn)
    child.stderr.emit('data', Buffer.from('connecting...\n'))
    child.stdout.emit('data', Buffer.from('x tunneled, https://abc123.lhr.life\n'))
    // Whatever provider this machine has, feed both shapes
    child.stdout.emit('data', Buffer.from('https://abc-123.trycloudflare.com\n'))
    const t = await p
    expect(t.url).toMatch(/^https:\/\/abc/)
    expect(currentTunnel()?.pid).toBe(4242)
    const again = await startTunnel(3000, '/tmp/botva-tunnel-test', spawnFn)
    expect(again.url).toBe(t.url)
    expect(spawnFn).toHaveBeenCalledOnce()
  })

  it('rejects when the provider exits before printing an address', async () => {
    const child = fakeChild()
    const p = startTunnel(3000, '/tmp/botva-tunnel-test', (() => child) as any)
    child.emit('exit', 255)
    await expect(p).rejects.toThrow(/exited \(255\)/)
    expect(currentTunnel()).toBeNull()
  })

  it('stopTunnel kills the process and forgets it', async () => {
    const child = fakeChild()
    const p = startTunnel(3000, '/tmp/botva-tunnel-test', (() => child) as any)
    child.stdout.emit('data', Buffer.from('https://zz.lhr.life https://zz.trycloudflare.com'))
    await p
    stopTunnel()
    expect(child.kill).toHaveBeenCalled()
    expect(currentTunnel()).toBeNull()
  })
})
