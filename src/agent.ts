import { query, type SDKMessage, type McpSdkServerConfigWithInstance, type AgentDefinition, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { BOT_DIR, BOT_NAME, PROJECT_ROOT, TYPING_REFRESH_MS, AGENT_WATCHDOG_WARN_SECONDS, AGENT_WATCHDOG_TIMEOUT_MS, SANDBOX_ENABLED, BACKGROUND_TASK_MAX_MS } from './config.js'
import { buildSandboxSettings } from './sandbox-config.js'
import { parseModelConfig, getFallbackModel } from './model.js'
import { buildMcpServers } from './mcp-config.js'
import { refreshClaudeMd } from './workspace-files.js'
import { readEnvFile } from './env.js'
import { isManager } from './team.js'
import { logger } from './logger.js'
import { createAbortController, setActiveQuery, clearActiveQuery, isCancelled, isInterrupted, clearInterrupted, setLiveRun, setBackgroundTasks, type BackgroundTask } from './request-queue.js'
import { LiveInput } from './live-input.js'
import { AgentWatchdog } from './agent-watchdog.js'
import { getClaudeProjectDir } from './disk-sessions.js'
import { buildRestrictedOptions, type RunRestrictions } from './run-restrictions.js'
import { existsSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'

/**
 * Strip lone UTF-16 surrogates from a string. Anthropic API rejects bodies
 * containing unpaired surrogates with "invalid high surrogate in string".
 * Replaces unpaired code units with U+FFFD.
 */
function stripLoneSurrogates(s: string): string {
  if (!s) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1]
        i++
      } else {
        out += '\ufffd'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\ufffd'
    } else {
      out += s[i]
    }
  }
  return out
}

/** Check session .jsonl file exists and has valid JSON on first line */
function validateSessionFile(sessionId: string): boolean {
  try {
    const filePath = join(getClaudeProjectDir(BOT_DIR), `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return false
    // Read only the first 4KB to avoid loading large session files
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const bytesRead = readSync(fd, buf, 0, 4096, 0)
      if (bytesRead === 0) return false
      const chunk = buf.toString('utf-8', 0, bytesRead)
      const newlineIdx = chunk.indexOf('\n')
      const firstLine = (newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk).trim()
      if (!firstLine) return false
      JSON.parse(firstLine)
      return true
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextWindow: number
  costUSD: number
  lastTurnContextTokens: number  // actual context used in last API call
}

/** One answered turn of a live run. */
export interface TurnResult {
  text: string | null
  usage?: UsageStats
  /** The turn ended because the user pressed stop. */
  interrupted: boolean
}

/**
 * Hooks for a run that talks to a person. Without them a run behaves as a
 * one-shot: one message in, the last answer out.
 */
export interface LiveHooks {
  /**
   * Every answered turn, as it ends. A live run can have several: one per
   * follow-up the model took as a turn of its own, and one each time a
   * background task finishes and the model reports on it.
   */
  onTurnResult?: (r: TurnResult) => Promise<void>
  /** A follow-up was pushed into the run (for the progress view). */
  onFollowup?: (text: string) => void
  /** Wrap a follow-up before it reaches the model. */
  formatFollowup?: (text: string) => string
}

/**
 * After the last background task ends, the model reports on it in a turn of
 * its own. Give that turn a moment to start before the input is closed.
 */
const BACKGROUND_SETTLE_MS = 3000

/** modelUsage of a result counts the whole process; one turn is the difference. */
type UsageTotals = Omit<UsageStats, 'lastTurnContextTokens'>
function sumModelUsage(modelUsage: Record<string, any>): UsageTotals | undefined {
  const models = Object.values(modelUsage ?? {})
  if (models.length === 0) return undefined
  return models.reduce(
    (acc: UsageTotals, m: any) => ({
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + m.cacheReadInputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationInputTokens,
      contextWindow: Math.max(acc.contextWindow, m.contextWindow),
      costUSD: acc.costUSD + m.costUSD,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, costUSD: 0 },
  )
}

export function usageDelta(now: UsageTotals, before: UsageTotals | undefined): UsageTotals {
  if (!before) return now
  return {
    inputTokens: Math.max(0, now.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, now.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, now.cacheReadTokens - before.cacheReadTokens),
    cacheCreationTokens: Math.max(0, now.cacheCreationTokens - before.cacheCreationTokens),
    contextWindow: now.contextWindow,
    costUSD: Math.max(0, now.costUSD - before.costUSD),
  }
}

/** Events that mean the main thread is working (not a background subagent). */
function isMainTurnActivity(event: SDKMessage): boolean {
  if (event.type !== 'assistant' && event.type !== 'user' && event.type !== 'stream_event') return false
  return !(event as { parent_tool_use_id?: string | null }).parent_tool_use_id
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
  onPermissionRequest?: (toolName: string, summary: string) => Promise<boolean>,
  mcpAllowList?: string[],
  agents?: Record<string, AgentDefinition>,
  effort?: 'low' | 'medium' | 'high' | 'max',
  resumeAt?: string,
  disallowedTools?: string[],
  restrictions?: RunRestrictions,
  hooks?: LiveHooks
): Promise<{ text: string | null; newSessionId?: string; usage?: UsageStats; sessionFailed?: boolean }> {
  let newSessionId: string | undefined
  let resultText: string | null = null
  let recentAssistantTexts: string[] = []  // this turn's assistant text blocks, for interrupt
  let usage: UsageStats | undefined
  let sessionFailed = false
  let lastTurnContextTokens = 0
  let usageBefore: UsageTotals | undefined

  // Streaming input: the run stays open for follow-ups and background tasks,
  // and closes once it is idle (see closeIfIdle below).
  const input = new LiveInput()
  let turnRunning = true
  const background = new Map<string, BackgroundTask>()
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined
  const clearIdleTimers = () => {
    if (settleTimer) clearTimeout(settleTimer)
    if (maxWaitTimer) clearTimeout(maxWaitTimer)
    settleTimer = maxWaitTimer = undefined
  }
  input.onPush = () => { turnRunning = true; clearIdleTimers() }
  // No turn running: close now, or — while background tasks run — wait for
  // them, and for the turn in which the model reports on the last one.
  const closeIfIdle = (justSettled = false) => {
    if (input.isClosed || turnRunning) return
    if (background.size === 0) {
      if (!justSettled) { input.close(); return }
      if (maxWaitTimer) clearTimeout(maxWaitTimer)
      maxWaitTimer = undefined
      settleTimer ??= setTimeout(() => { settleTimer = undefined; if (!turnRunning) input.close() }, BACKGROUND_SETTLE_MS)
      return
    }
    maxWaitTimer ??= setTimeout(() => {
      logger.warn({ chatId, tasks: [...background.values()].map(t => t.description) }, 'Background tasks outlived the wait limit, closing the run')
      input.close()
    }, BACKGROUND_TASK_MAX_MS)
  }
  input.push(stripLoneSurrogates(message))

  // Typing only while a turn runs — not while the run waits for background work
  const typingInterval = onTyping
    ? setInterval(() => { if (turnRunning) onTyping() }, TYPING_REFRESH_MS)
    : undefined

  const watchdog = new AgentWatchdog({
    chatId,
    warnAfterSeconds: AGENT_WATCHDOG_WARN_SECONDS,
    logIntervalSeconds: 30,
    timeoutMs: AGENT_WATCHDOG_TIMEOUT_MS,
  })

  const abortController = createAbortController(chatId)

  let mcpServers: Record<string, any> = {}
  try {
    // No allowlist means "every server" — except for a restricted run, where it
    // means none: the run gets only the servers it was explicitly handed.
    const serverAllowList = restrictions && !mcpAllowList ? [] : mcpAllowList
    mcpServers = await buildMcpServers({ ...process.env as Record<string, string>, ...readEnvFile() }, serverAllowList)

    // Built-in tools MCP (image generation, voice, telegraph, etc.)
    if (builtinMcpServer) {
      mcpServers['builtin'] = builtinMcpServer
    }

    // Inter-bot communication MCP (reads role from workspace/team.json).
    // A restricted run talks to no one, so it gets no colleague channel either.
    if (restrictions) {
      // no inter-bot channel
    } else if (BOT_NAME && isManager(PROJECT_ROOT, BOT_NAME)) {
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

    logger.debug({ chatId, model, effort, sessionId: sessionId?.slice(0, 8) }, 'Starting agent query')

    // Plan mode: research & analyze freely, block destructive/modifying operations.
    // Like Claude Code /plan — agent reads, searches, saves facts, sends plan to user.
    // Bash allowed for read commands (ls, git log, cat), blocked for destructive ones.
    const PLAN_BLOCKED_TOOLS = ['Write', 'Edit', 'NotebookEdit']
    const PLAN_BLOCKED_BUILTIN = new Set([
      'SendEmail', 'ForwardMessage', 'SetReaction',
      'CreateReminder', 'DeleteReminder',
      'DeleteFact',
      'WriteWorkspaceFile',
      'GenerateImage', 'EditImage', 'TextToSpeech',
      'CreateBot', 'DeleteBot', 'RotateBotToken',
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

    // Ask mode — migrated from a PreToolUse hook to the SDK `canUseTool`
    // callback (SDK ≥0.3.186). Read-only tools auto-approve; everything else
    // bridges to Telegram approve/deny buttons via onPermissionRequest.
    //
    // canUseTool is only consulted when permissionMode is NOT bypassPermissions
    // (bypass short-circuits every permission check), so ask mode runs under
    // permissionMode:'default' instead. Plan/debate keep their PreToolUse hooks
    // and their bypass mode untouched.
    const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Task']
    const askMode = !!onPermissionRequest
    const askCanUseTool: CanUseTool | undefined = onPermissionRequest ? async (toolName, input, opts) => {
      if (READ_ONLY_TOOLS.includes(toolName)) {
        return { behavior: 'allow', updatedInput: input } as PermissionResult
      }
      const toolInput = (input ?? {}) as Record<string, any>
      const summary = toolInput.command
        ? `bash: ${String(toolInput.command).slice(0, 150)}`
        : toolInput.file_path
          ? `${toolName}: ${toolInput.file_path}`
          : toolName
      // Background/task subagents forward their prompts here (agentID set) instead
      // of being auto-denied — flag them so the user knows who is asking.
      const label = opts.agentID ? `(субагент) ${toolName}` : toolName
      const allowed = await onPermissionRequest(label, summary)
      return (allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Denied by user' }) as PermissionResult
    } : undefined

    const { model: baseModel } = model ? parseModelConfig(model) : { model: undefined as string | undefined }
    // Resilience: let the SDK auto-demote to a lower tier if the primary model
    // is overloaded/unavailable (re-tried at the start of each user turn).
    const fallbackModel = baseModel ? getFallbackModel(baseModel) : undefined

    const conversation = query({
      prompt: input,
      options: {
        // Stop ends the turn, not the background tasks; those are stopped one
        // by one (/tasks), or all at once by the hard interrupt.
        perTaskStopAffordance: true,
        cwd: BOT_DIR,
        // Ask mode needs 'default' so the SDK consults canUseTool; all other
        // modes keep the historical bypass behaviour (plan/debate gate via hooks).
        permissionMode: (askMode ? 'default' : 'bypassPermissions') as any,
        ...(askMode ? {} : { allowDangerouslySkipPermissions: true }),
        settingSources: ['project', 'user'],
        abortController,
        mcpServers,
        includePartialMessages: true,
        agentProgressSummaries: true,
        // Adaptive thinking з summarized-текстом: сире мислення нові моделі редагують
        // (порожні thinking-блоки), а summarized-резюме стрімиться і показується юзеру
        thinking: { type: 'adaptive', display: 'summarized' } as any,
        ...planHooks,
        ...debateHooks,
        ...(askCanUseTool ? { canUseTool: askCanUseTool } : {}),
        ...(baseModel ? { model: baseModel } : {}),
        ...(fallbackModel ? { fallbackModel } : {}),
        ...(effort ? { effort } : {}),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(sessionId && resumeAt ? { resumeSessionAt: resumeAt } : {}),
        ...(agents && Object.keys(agents).length > 0 ? { agents } : {}),
        ...(disallowedTools && disallowedTools.length > 0 ? { disallowedTools } : {}),
        // Opt-in only (SANDBOX_ENABLED): sandbox the agent's Bash tool and mask
        // sensitive API keys present in the environment. Flag off → no sandbox
        // key at all, default behaviour unchanged.
        ...(SANDBOX_ENABLED ? { sandbox: buildSandboxSettings() } : {}),
        // Last, so it overrides the permission mode and hooks set above, and
        // drops subagents: a restricted run gets only its allowlist.
        ...(restrictions ? { ...buildRestrictedOptions(restrictions), agents: {} } : {}),
      },
    })

    setActiveQuery(chatId, conversation)
    setLiveRun(chatId, {
      push: (text) => {
        const clean = stripLoneSurrogates(text)
        if (!input.push(hooks?.formatFollowup ? hooks.formatFollowup(clean) : clean)) return false
        hooks?.onFollowup?.(clean)
        logger.info({ chatId }, 'Follow-up pushed into the live run')
        return true
      },
    })
    watchdog.start()

    for await (const event of conversation) {
      watchdog.recordActivity()
      if (isMainTurnActivity(event) && !turnRunning) {
        turnRunning = true
        clearIdleTimers()
      }
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
        } else if (sys.subtype === 'background_tasks_changed') {
          // Replace semantics: the payload is the full set of live tasks
          const hadTasks = background.size > 0
          background.clear()
          for (const t of (sys.tasks ?? []) as any[]) {
            if (t?.task_id) background.set(String(t.task_id), { taskId: String(t.task_id), type: String(t.task_type ?? ''), description: String(t.description ?? '') })
          }
          setBackgroundTasks(chatId, [...background.values()])
          closeIfIdle(hadTasks && background.size === 0)
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
          logger.info({ chatId, requestedModel: model, requestedEffort: effort, actualModels: modelIds }, 'Agent completed with models')
        }
        const totals = sumModelUsage(event.modelUsage)
        if (totals) {
          usage = { ...usageDelta(totals, usageBefore), lastTurnContextTokens }
          usageBefore = totals
        }

        const interrupted = isInterrupted(chatId)
        recentAssistantTexts = []
        turnRunning = false
        if (hooks?.onTurnResult) {
          try {
            await hooks.onTurnResult({ text: resultText, usage, interrupted })
          } catch (err) {
            logger.error({ err, chatId }, 'Delivering a turn result failed')
          }
        }
        if (interrupted) clearInterrupted(chatId)
        closeIfIdle()
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
    input.close()
    clearIdleTimers()
    watchdog.stop()
    clearActiveQuery(chatId)
    if (typingInterval) clearInterval(typingInterval)
    // Close MCP servers
    for (const [name, server] of Object.entries(mcpServers)) {
      try {
        if (typeof server?.close === 'function') await server.close()
        else if (typeof server?.stop === 'function') await server.stop()
        else if (typeof server?.instance?.close === 'function') await server.instance.close()
      } catch (err) {
        logger.warn({ err, name }, 'MCP server cleanup failed')
      }
    }
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
  onPermissionRequest?: (toolName: string, summary: string) => Promise<boolean>,
  mcpAllowList?: string[],
  agents?: Record<string, AgentDefinition>,
  effort?: 'low' | 'medium' | 'high' | 'max',
  resumeAt?: string,
  /**
   * Tool names the SDK must drop from the model's context entirely.
   *
   * Used to hand a narrower Telegram to unattended runs: they may read and may
   * edit the owner's own notes and contacts, but the tools that speak to other
   * people are not merely refused — they are never offered.
   */
  disallowedTools?: string[],
  /**
   * Confine the run to an allowlist of tools (see run-restrictions.ts). For
   * runs driven by text the owner did not write: guest queries, other bots.
   */
  restrictions?: RunRestrictions,
  /** Follow-ups, background tasks and per-turn delivery (see LiveHooks). */
  hooks?: LiveHooks
): Promise<{ text: string | null; newSessionId?: string; usage?: UsageStats }> {
  // Reassemble CLAUDE.md from workspace files so changes (USER.md, MEMORY.md) are picked up
  refreshClaudeMd(BOT_DIR)

  // Validate session file before passing to SDK — corrupted files cause crashes
  if (sessionId) {
    const validSession = validateSessionFile(sessionId)
    if (!validSession) {
      logger.warn({ chatId, sessionId: sessionId.slice(0, 8) }, 'Session file missing or corrupted, starting fresh')
      const { clearSession } = await import('./db.js')
      clearSession(chatId)
      sessionId = undefined
    }
  }

  const result = await runAgentOnce(message, sessionId, onTyping, chatId, onEvent, model, builtinMcpServer, permissionMode, onPermissionRequest, mcpAllowList, agents, effort, resumeAt, disallowedTools, restrictions, hooks)

  // If failed with a session, retry without session (fresh start)
  if (result.sessionFailed) {
    logger.warn({ chatId, sessionId }, 'Session failed, clearing and retrying without session')
    const { clearSession } = await import('./db.js')
    clearSession(chatId)

    const retry = await runAgentOnce(message, undefined, onTyping, chatId, onEvent, model, builtinMcpServer, permissionMode, onPermissionRequest, mcpAllowList, agents, effort, undefined, disallowedTools, restrictions, hooks)
    if (retry.sessionFailed || (!retry.text && !retry.newSessionId)) {
      logger.error({ chatId }, 'Retry without session also failed')
      return { text: '{{agent.crash.double}}', newSessionId: retry.newSessionId, usage: retry.usage }
    }
    return { text: retry.text, newSessionId: retry.newSessionId, usage: retry.usage }
  }

  return { text: result.text, newSessionId: result.newSessionId, usage: result.usage }
}
