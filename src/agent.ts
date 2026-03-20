import { query, type SDKMessage, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { BOT_DIR, BOT_NAME, PROJECT_ROOT, TYPING_REFRESH_MS, AGENT_WATCHDOG_WARN_SECONDS, AGENT_WATCHDOG_TIMEOUT_MS } from './config.js'
import { buildMcpServers } from './mcp-config.js'
import { refreshClaudeMd } from './workspace-files.js'
import { readEnvFile } from './env.js'
import { isManager } from './team.js'
import { logger } from './logger.js'
import { createAbortController, setActiveQuery, clearActiveQuery, isCancelled, isInterrupted } from './request-queue.js'
import { AgentWatchdog } from './agent-watchdog.js'

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextWindow: number
  costUSD: number
  lastTurnContextTokens: number  // actual context used in last API call
}

async function runAgentOnce(
  message: string,
  sessionId: string | undefined,
  onTyping: (() => void) | undefined,
  chatId: string,
  onEvent?: (event: SDKMessage) => void,
  model?: string,
  builtinMcpServer?: McpSdkServerConfigWithInstance,
  permissionMode?: string,
  onPermissionRequest?: (toolName: string, summary: string) => Promise<boolean>
): Promise<{ text: string | null; newSessionId?: string; usage?: UsageStats; sessionFailed?: boolean }> {
  let newSessionId: string | undefined
  let resultText: string | null = null
  const recentAssistantTexts: string[] = []  // collect assistant text blocks for interrupt
  let usage: UsageStats | undefined
  let sessionFailed = false
  let lastTurnContextTokens = 0

  const typingInterval = onTyping
    ? setInterval(onTyping, TYPING_REFRESH_MS)
    : undefined

  const watchdog = new AgentWatchdog({
    chatId,
    warnAfterSeconds: AGENT_WATCHDOG_WARN_SECONDS,
    logIntervalSeconds: 30,
    timeoutMs: AGENT_WATCHDOG_TIMEOUT_MS,
  })

  const abortController = createAbortController(chatId)

  try {
    const mcpServers: Record<string, any> = await buildMcpServers({ ...process.env as Record<string, string>, ...readEnvFile() })

    // Built-in tools MCP (image generation, voice, telegraph, etc.)
    if (builtinMcpServer) {
      mcpServers['builtin'] = builtinMcpServer
    }

    // Inter-bot communication MCP (reads role from workspace/team.json)
    if (BOT_NAME && isManager(PROJECT_ROOT, BOT_NAME)) {
      mcpServers['colleague'] = {
        command: 'node',
        args: [`${PROJECT_ROOT}/mcp-servers/colleague/build/index.js`],
        env: { ...process.env as Record<string, string>, PROJECT_ROOT },
      }
    } else if (BOT_NAME) {
      mcpServers['manager'] = {
        command: 'node',
        args: [`${PROJECT_ROOT}/mcp-servers/manager/build/index.js`],
        env: { ...process.env as Record<string, string>, PROJECT_ROOT, BOT_NAME },
      }
    }

    logger.debug({ chatId, model, sessionId: sessionId?.slice(0, 8) }, 'Starting agent query')

    // Plan mode: research & analyze freely, block destructive/modifying operations.
    // Like Claude Code /plan — agent reads, searches, saves facts, sends plan to user.
    // Bash allowed for read commands (ls, git log, cat), blocked for destructive ones.
    const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'NotebookEdit']
    const PLAN_BLOCKED_BUILTIN = new Set([
      'SendEmail', 'ForwardMessage', 'SetReaction',
      'CreateReminder', 'DeleteReminder',
      'DeleteFact',
      'WriteWorkspaceFile', 'DeleteWorkspaceFile',
      'GenerateImage', 'EditImage', 'TextToSpeech',
      'CreateBot', 'DeleteBot',
      'CreateBackup', 'DeleteBackup', 'RestoreBackup',
      'DeleteGalleryImage',
    ])
    const BASH_DESTRUCTIVE = /^\s*(rm\s|mv\s|cp\s|chmod\s|chown\s|sudo\s|kill\s|pkill\s|git\s+(push|reset|checkout|clean|rebase|merge|commit|stash)|npm\s+(publish|run)|node\s|python|pip\s|docker\s|rsync\s|scp\s|ssh\s|curl\s.*-X\s*(POST|PUT|DELETE|PATCH))/i
    const planHooks = permissionMode === 'plan' ? {
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any) => {
            const toolName = input.tool_name ?? ''
            // Block core write tools
            if (PLAN_BLOCKED_TOOLS.includes(toolName)) {
              return { decision: 'block' as const, reason: `${toolName} blocked in plan mode. Finish planning first.` }
            }
            // Bash: allow read commands, block destructive
            if (toolName === 'Bash') {
              const cmd = String(input.tool_input?.command ?? '')
              if (BASH_DESTRUCTIVE.test(cmd)) {
                return { decision: 'block' as const, reason: `Destructive bash command blocked in plan mode: ${cmd.slice(0, 60)}` }
              }
              return { decision: 'approve' as const }
            }
            // Block builtin write tools (called via MCP as mcp__builtin__ToolName)
            const builtinMatch = toolName.match(/^mcp__builtin__(.+)$/)
            if (builtinMatch && PLAN_BLOCKED_BUILTIN.has(builtinMatch[1])) {
              return { decision: 'block' as const, reason: `${builtinMatch[1]} blocked in plan mode. Finish planning first.` }
            }
            // Allow everything else: Read, Glob, Grep, Task, WebSearch, WebFetch, SendMedia, SaveFact, MCP reads
            return { decision: 'approve' as const }
          }],
        }],
      },
    } : {}

    // Debate mode: allow read tools + MCP (WebSearch, WebFetch, PubMed), block write tools (Bash, Write, Edit, etc.)
    const DEBATE_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Task', 'WebSearch', 'WebFetch']
    const DEBATE_BLOCKED_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit']
    const debateHooks = permissionMode === 'debate' ? {
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any) => {
            const toolName = input.tool_name ?? ''
            if (DEBATE_ALLOWED_TOOLS.includes(toolName)) {
              return { decision: 'approve' as const }
            }
            if (DEBATE_BLOCKED_TOOLS.includes(toolName)) {
              return { decision: 'block' as const, reason: 'Write tools disabled in debate mode' }
            }
            return { decision: 'approve' as const }
          }],
        }],
      },
    } : {}

    // PreToolUse hooks for ask mode — intercept dangerous tools
    const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Task']
    const permissionHooks = onPermissionRequest ? {
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any) => {
            const toolName = input.tool_name ?? ''
            if (READ_ONLY_TOOLS.includes(toolName)) {
              return { decision: 'approve' as const }
            }
            const toolInput = input.tool_input ?? {}
            const summary = toolInput.command
              ? `bash: ${String(toolInput.command).slice(0, 150)}`
              : toolInput.file_path
                ? `${toolName}: ${toolInput.file_path}`
                : toolName
            const allowed = await onPermissionRequest(toolName, summary)
            return allowed
              ? { decision: 'approve' as const }
              : { decision: 'block' as const, reason: 'Denied by user' }
          }],
        }],
      },
    } : {}

    const conversation = query({
      prompt: message,
      options: {
        cwd: BOT_DIR,
        permissionMode: 'bypassPermissions' as any,
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        abortController,
        mcpServers,
        includePartialMessages: true,
        agentProgressSummaries: true,
        ...planHooks,
        ...debateHooks,
        ...permissionHooks,
        ...(model ? { model } : {}),
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })

    setActiveQuery(chatId, conversation)
    watchdog.start()

    for await (const event of conversation) {
      watchdog.recordActivity()
      onEvent?.(event)

      // Hard cancel — abort immediately, discard result
      if (isCancelled(chatId)) {
        resultText = '(запит скасовано)'
        break
      }
      // Soft interrupt — let the agent finish, keep the result
      // (no break — we continue reading events until result arrives)

      // Log rate limit warnings
      if (event.type === 'rate_limit_event') {
        const info = (event as any).rate_limit_info
        if (info?.status === 'allowed_warning') {
          logger.warn({ chatId, utilization: info.utilization, resetsAt: info.resetsAt }, 'Rate limit warning')
        } else if (info?.status === 'rejected') {
          logger.warn({ chatId, resetsAt: info.resetsAt }, 'Rate limit rejected')
        }
      }

      // Log task (subagent) lifecycle
      if (event.type === 'system') {
        const sys = event as any
        if (sys.subtype === 'task_started') {
          logger.info({ chatId, taskId: sys.task_id, description: sys.description }, 'Subtask started')
        } else if (sys.subtype === 'task_notification') {
          logger.info({ chatId, taskId: sys.task_id, status: sys.status }, 'Subtask finished')
        }
      }

      // Track last assistant message text and context window usage
      if (event.type === 'assistant') {
        if (event.message?.content) {
          const textParts = event.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text as string)
          if (textParts.length > 0) {
            recentAssistantTexts.push(textParts.join('\n'))
          }
        }
        if (event.message?.usage) {
          const u = event.message.usage
          lastTurnContextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        }
      }

      if (event.type === 'system' && event.subtype === 'init') {
        newSessionId = event.session_id
        logger.debug({ sessionId: newSessionId }, 'Session initialized')
      }

      if (event.type === 'result') {
        if (event.subtype === 'success') {
          resultText = event.result
        } else if (isInterrupted(chatId)) {
          // On interrupt, SDK may return error result — prefer partial text
          const partial = recentAssistantTexts.slice(-8).join('\n\n')
          resultText = partial || (event as any).result || null
        } else {
          resultText = event.errors?.join('\n') ?? 'Error occurred'
        }

        // Only discard result on hard cancel, not on soft interrupt
        if (isCancelled(chatId) && !isInterrupted(chatId)) {
          resultText = '(запит скасовано)'
        }

        const modelIds = Object.keys(event.modelUsage)
        if (modelIds.length > 0) {
          logger.info({ chatId, requestedModel: model, actualModels: modelIds }, 'Agent completed with models')
        }
        const models = Object.values(event.modelUsage)
        if (models.length > 0) {
          const totals = models.reduce(
            (acc, m) => ({
              inputTokens: acc.inputTokens + m.inputTokens,
              outputTokens: acc.outputTokens + m.outputTokens,
              cacheReadTokens: acc.cacheReadTokens + m.cacheReadInputTokens,
              cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationInputTokens,
              contextWindow: Math.max(acc.contextWindow, m.contextWindow),
              costUSD: acc.costUSD + m.costUSD,
            }),
            { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, costUSD: 0 }
          )
          usage = { ...totals, lastTurnContextTokens }
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)

    const wasAborted = errMsg.includes('Request was aborted') || errMsg.includes('aborted')

    if (isInterrupted(chatId) || (wasAborted && !isCancelled(chatId))) {
      // Soft interrupt — return partial result (like ESC in Claude Code)
      // Always prefer partial text over SDK crash errors in resultText
      const partial = recentAssistantTexts.slice(-8).join('\n\n')
      if (partial) {
        resultText = partial
      } else if (!resultText) {
        resultText = null  // null = no message sent
      }
    } else if (isCancelled(chatId) || wasAborted) {
      resultText = '(запит скасовано)'
    } else {
      const isProcessCrash = errMsg.includes('exited with code') || errMsg.includes('not ready for writing') || errMsg.includes('terminated process') || errMsg.includes('Cannot read properties of undefined')

      if (isProcessCrash && sessionId) {
        logger.warn({ err, chatId, sessionId: sessionId.slice(0, 8) }, 'Agent process crashed with session, will retry fresh')
        sessionFailed = true
      } else if (isProcessCrash) {
        logger.error({ err, chatId, model }, 'Agent process crashed without session')
        const partial = recentAssistantTexts.slice(-4).join('\n\n')
        if (partial) {
          resultText = `${partial}\n\n{{agent.crash.partial}}`
        } else {
          resultText = '{{agent.crash}}'
        }
      } else {
        logger.error({ err, chatId, model, sessionId: sessionId?.slice(0, 8) }, 'Agent error')
        resultText = `{{agent.error}} ${errMsg}`
      }
    }
  } finally {
    watchdog.stop()
    clearActiveQuery(chatId)
    if (typingInterval) clearInterval(typingInterval)
  }

  return { text: resultText, newSessionId, usage, sessionFailed }
}

export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: (() => void) | undefined,
  chatId: string,
  onEvent?: (event: SDKMessage) => void,
  model?: string,
  builtinMcpServer?: McpSdkServerConfigWithInstance,
  permissionMode?: string,
  onPermissionRequest?: (toolName: string, summary: string) => Promise<boolean>
): Promise<{ text: string | null; newSessionId?: string; usage?: UsageStats }> {
  // Reassemble CLAUDE.md from workspace files so changes (BOOTSTRAP.md, USER.md, MEMORY.md) are picked up
  refreshClaudeMd(BOT_DIR)

  const result = await runAgentOnce(message, sessionId, onTyping, chatId, onEvent, model, builtinMcpServer, permissionMode, onPermissionRequest)

  // If failed with a session, retry without session (fresh start)
  if (result.sessionFailed) {
    logger.warn({ chatId, sessionId }, 'Session failed, clearing and retrying without session')
    const { clearSession } = await import('./db.js')
    clearSession(chatId)

    const retry = await runAgentOnce(message, undefined, onTyping, chatId, onEvent, model, builtinMcpServer, permissionMode, onPermissionRequest)
    if (retry.sessionFailed || (!retry.text && !retry.newSessionId)) {
      logger.error({ chatId }, 'Retry without session also failed')
      return { text: '{{agent.crash.double}}', newSessionId: retry.newSessionId, usage: retry.usage }
    }
    return { text: retry.text, newSessionId: retry.newSessionId, usage: retry.usage }
  }

  return { text: result.text, newSessionId: result.newSessionId, usage: result.usage }
}
