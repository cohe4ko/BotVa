/**
 * Keep the agent on its tools instead of around them.
 *
 * The bot's Telegram token sits in its .env, and the agent has Bash. Asked to
 * do something its tools do not allow (or not yet — TGAP switched off), a
 * model will happily read the token and call the Bot API with curl: messages
 * go out with no owner approval, no limits, no audit, and the reply is never
 * routed back. This guard refuses that at the tool call and says which tool to
 * use instead.
 *
 * It catches the direct route, not every conceivable one — the rule in
 * roles/_tools.md covers intent; this makes the obvious shortcut fail loudly.
 */

import { resolve, sep } from 'path'

/** A Bot API call with a token in it: api.telegram.org/bot<token or variable>. */
const BOT_API_CALL = /api\.telegram\.org\/(?:file\/)?bot(?:\$|\{|\d{6,}:)/i
/** The token variable used together with a way to make a request. */
const TOKEN_VAR = /TELEGRAM_BOT_TOKEN/
const HTTP_CLIENT = /\b(?:curl|wget|http|https|requests\.|urllib|fetch\(|axios|httpx)\b/i

export const DIRECT_BOT_API_REASON =
  'Blocked: calling the Telegram Bot API directly with the bot token bypasses the bot\'s tools — no owner approval, limits or audit, and replies never come back. ' +
  'Use the tools: SendMedia / ForwardMessage / SetReaction / PinMessage for this chat, AskExternalBot for another person\'s bot, ask_colleague / ask_manager for team bots, tg_send_message for the owner\'s own account. ' +
  'If no tool fits or a tool says it is turned off, tell the owner what is missing instead of working around it.'

export const VAULT_KEY_REASON =
  'Blocked: store/vault.key is the master key of the secret vault. Secrets are used through {{secret:name.field}} placeholders in tool calls, never read directly.'

/** Any mention of the vault key file in a tool call that can read, copy or send it. */
function touchesVaultKey(toolName: string, i: Record<string, unknown>): boolean {
  if (!['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return false
  return /vault\.key/.test(JSON.stringify(i))
}

function writesPlatformCode(filePath: string, projectRoot: string): boolean {
  const abs = resolve(filePath)
  return ['src', 'mcp-servers', 'scripts'].some(d => abs.startsWith(resolve(projectRoot, d) + sep))
}

/**
 * Why this tool call goes around the bot's tools, or null if it does not.
 * `projectRoot`: edits to the platform's own code may contain Bot API URLs
 * (a developer bot working on BotVa), so those are left alone.
 */
export function directBotApiViolation(toolName: string, input: Record<string, unknown> | undefined, projectRoot: string): string | null {
  const i = input ?? {}
  if (touchesVaultKey(toolName, i)) {
    // The platform's own code names the file; editing it is fine, reading the key is not
    const filePath = String(i.file_path ?? '')
    if (!(filePath && writesPlatformCode(filePath, projectRoot) && toolName !== 'Read')) return VAULT_KEY_REASON
  }
  if (toolName === 'Bash') {
    const cmd = String(i.command ?? '')
    if (BOT_API_CALL.test(cmd) || (TOKEN_VAR.test(cmd) && HTTP_CLIENT.test(cmd))) return DIRECT_BOT_API_REASON
    return null
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const filePath = String(i.file_path ?? '')
    if (filePath && writesPlatformCode(filePath, projectRoot)) return null
    const text = [i.content, i.new_string, ...(Array.isArray(i.edits) ? i.edits.map((e: any) => e?.new_string) : [])]
      .filter(v => typeof v === 'string').join('\n')
    if (BOT_API_CALL.test(text)) return DIRECT_BOT_API_REASON
  }
  return null
}

/** PreToolUse hook for the SDK. */
export function toolGuardHook(projectRoot: string) {
  return async (input: any) => {
    const reason = directBotApiViolation(String(input?.tool_name ?? ''), input?.tool_input, projectRoot)
    return reason ? { decision: 'block' as const, reason } : {}
  }
}
