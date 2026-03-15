import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { logger } from './logger.js'

interface PersistentServer {
  client: Client
  transport: StdioClientTransport
}

class PersistentMcpManager {
  private servers = new Map<string, PersistentServer>()

  /**
   * Ensure persistent subprocess is running, return McpSdkServerConfigWithInstance.
   * Idempotent: if already running, creates only a new SDK server wrapper.
   */
  async getServer(
    name: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<McpSdkServerConfigWithInstance> {
    // 1. Ensure subprocess + client connection
    let server = this.servers.get(name)
    if (!server || !this.isAlive(server)) {
      // Clean up dead server if any
      if (server) {
        await this.closeServer(name, server)
      }
      server = await this.spawn(name, command, args, env)
      this.servers.set(name, server)
    }

    // 2. List tools from subprocess
    const { tools: remoteTools } = await server.client.listTools()
    logger.debug({ name, toolCount: remoteTools.length }, 'Persistent MCP: listed tools')

    // 3. Create proxy tool definitions
    const client = server.client
    const sdkTools = remoteTools.map(t => {
      // Build Zod shape from JSON Schema properties (pass-through, remote server validates)
      const shape: Record<string, z.ZodTypeAny> = {}
      const props = t.inputSchema.properties ?? {}
      const required = new Set(t.inputSchema.required ?? [])
      for (const key of Object.keys(props)) {
        shape[key] = required.has(key) ? z.any() : z.any().optional()
      }

      return tool(
        t.name,
        t.description ?? t.name,
        shape,
        async (args) => {
          const result = await client.callTool({ name: t.name, arguments: args })
          // Forward result content (text, image, etc.) directly
          if ('content' in result) {
            return {
              content: result.content,
              ...(result.isError ? { isError: true } : {}),
            } as any
          }
          // Fallback for unexpected result format
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        },
        t.annotations ? { annotations: t.annotations } : undefined,
      )
    })

    // 4. Wrap in McpSdkServerConfigWithInstance (new per query, reuses persistent client)
    return createSdkMcpServer({ name, version: '1.0.0', tools: sdkTools })
  }

  /** Check if a persistent server is currently running */
  isRunning(name: string): boolean {
    const server = this.servers.get(name)
    return !!server && this.isAlive(server)
  }

  /** Get PID of running persistent server */
  getPid(name: string): number | null {
    const server = this.servers.get(name)
    if (!server || !this.isAlive(server)) return null
    return server.transport.pid
  }

  stop(name: string): void {
    const server = this.servers.get(name)
    if (server) {
      this.closeServer(name, server)
    }
  }

  stopAll(): void {
    for (const name of [...this.servers.keys()]) {
      this.stop(name)
    }
  }

  private async spawn(
    name: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<PersistentServer> {
    logger.info({ name, command, args: args.join(' ') }, 'Persistent MCP: spawning')

    const transport = new StdioClientTransport({
      command,
      args,
      env: env ? { ...process.env as Record<string, string>, ...env } : undefined,
      stderr: 'pipe',
    })

    // Log stderr from subprocess
    const stderr = transport.stderr
    if (stderr) {
      stderr.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim()
        if (msg) logger.debug({ name }, `Persistent MCP stderr: ${msg}`)
      })
    }

    const client = new Client({ name: `botva-${name}`, version: '1.0.0' })

    transport.onclose = () => {
      logger.warn({ name }, 'Persistent MCP: transport closed')
      this.servers.delete(name)
    }

    await client.connect(transport)
    logger.info({ name, pid: transport.pid }, 'Persistent MCP: connected')

    return { client, transport }
  }

  private isAlive(server: PersistentServer): boolean {
    // StdioClientTransport exposes pid; if null, process is dead
    return server.transport.pid !== null
  }

  private async closeServer(name: string, server: PersistentServer): Promise<void> {
    try {
      await server.client.close()
    } catch {
      // ignore
    }
    try {
      await server.transport.close()
    } catch {
      // ignore
    }
    this.servers.delete(name)
    logger.info({ name }, 'Persistent MCP: stopped')
  }
}

export const persistentMcp = new PersistentMcpManager()
