import { query, type SDKMessage, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { BOT_DIR, BOT_NAME, PROJECT_ROOT, TYPING_REFRESH_MS, AGENT_WATCHDOG_WARN_SECONDS, AGENT_WATCHDOG_TIMEOUT_MS } from './config.js'
import { buildMcpServers } from './mcp-config.js'
import { readEnvFile } from './env.js'
import { isManager } from './team.js'
import { logger } from './logger.js'
import { createAbortController, setActiveQuery, clearActiveQuery, isCancelled, isInterrupted } from './request-queue.js'
import { AgentWatchdog } from './agent-watchdog.js'

export interface AskUserQuestion {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiSelect?: boolean
}

export type AskUserHandler = (questions: AskUserQuestion[]) => Promise<string>

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
  onAskUser?: AskUserHandler,
  builtinMcpServer?: McpSdkServerConfigWithInstance
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
    const mcpServers: Record<string, any> = buildMcpServers({ ...process.env as Record<string, string>, ...readEnvFile() })

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

    // AskUserQuestion handler via canUseTool
    const canUseTool = onAskUser
      ? async (toolName: string, input: Record<string, unknown>) => {
          if (toolName === 'AskUserQuestion') {
            try {
              const questions = (input.questions ?? []) as AskUserQuestion[]
              const answer = await onAskUser(questions)
              return {
                behavior: 'deny' as const,
                message: `Відповідь користувача: ${answer}`,
              }
            } catch (err) {
              return {
                behavior: 'deny' as const,
                message: 'Користувач не відповів на питання.',
              }
            }
          }
          return { behavior: 'allow' as const, updatedInput: input }
        }
      : undefined

    const conversation = query({
      prompt: message,
      options: {
        cwd: BOT_DIR,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        abortController,
        mcpServers,
        includePartialMessages: true,
        agentProgressSummaries: true,
        ...(canUseTool ? { canUseTool } : {}),
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
        resultText = event.subtype === 'success' ? event.result : (event.errors?.join('\n') ?? 'Error occurred')

        // Only discard result on hard cancel, not on soft interrupt
        if (isCancelled(chatId) && !isInterrupted(chatId)) {
          resultText = '(запит скасовано)'
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
      if (!resultText) {
        const partial = recentAssistantTexts.slice(-8).join('\n\n')
        resultText = partial || null  // null = no message sent
      }
    } else if (isCancelled(chatId) || wasAborted) {
      resultText = '(запит скасовано)'
    } else {
      logger.error({ err }, 'Agent error')

      if ((errMsg.includes('exited with code') || errMsg.includes('not ready for writing') || errMsg.includes('terminated process')) && sessionId) {
        sessionFailed = true
      } else {
        resultText = `Помилка агента: ${errMsg}`
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
  onAskUser?: AskUserHandler,
  builtinMcpServer?: McpSdkServerConfigWithInstance
): Promise<{ text: string | null; newSessionId?: string; usage?: UsageStats }> {
  const result = await runAgentOnce(message, sessionId, onTyping, chatId, onEvent, model, onAskUser, builtinMcpServer)

  // If failed with a session, retry without session (fresh start)
  if (result.sessionFailed) {
    logger.warn({ chatId, sessionId }, 'Session failed, clearing and retrying without session')
    const { clearSession } = await import('./db.js')
    clearSession(chatId)

    const retry = await runAgentOnce(message, undefined, onTyping, chatId, onEvent, model, onAskUser, builtinMcpServer)
    return { text: retry.text, newSessionId: retry.newSessionId, usage: retry.usage }
  }

  return { text: result.text, newSessionId: result.newSessionId, usage: result.usage }
}
