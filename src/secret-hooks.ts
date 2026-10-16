/**
 * Secrets in tool calls: `{{secret:name.field}}` becomes the value right
 * before the tool runs, and the value becomes the placeholder again in what
 * the tool returns. See secrets.ts.
 */

import { hasPlaceholder, resolvePlaceholders, redact, listSecrets } from './secrets.js'

/**
 * Tools that carry text to people, to memory or to another model. A secret
 * placed there would leave the vault for good, so it is refused.
 */
const OUTWARD = new Set([
  'SendEmail', 'AskExternalBot', 'ManageExternalBots', 'SaveFact', 'BoostFact', 'WriteWorkspaceFile',
  'PublishTelegraph', 'CreateReminder', 'SendChecklist', 'NameSession', 'AskUser', 'AskGemini', 'GeminiSearch',
  'ask_colleague', 'ask_manager', 'WebSearch', 'WebFetch', 'TodoWrite',
])

const shortName = (tool: string) => tool.split('__').at(-1) ?? tool

/** Whether a secret may be put into this tool's input. */
export function secretAllowedIn(tool: string): boolean {
  if (OUTWARD.has(shortName(tool))) return false
  // The owner's Telegram account: anything there is a message to someone
  if (tool.startsWith('mcp__telegram__')) return false
  return true
}

export type PreDecision =
  | { kind: 'none' }
  | { kind: 'block'; reason: string }
  | { kind: 'replace'; input: Record<string, unknown>; used: string[] }

export function decideSecretInput(tool: string, input: unknown, askMode: boolean): PreDecision {
  if (!hasPlaceholder(input)) return { kind: 'none' }
  if (askMode) return { kind: 'block', reason: 'Secrets are not available while the owner approves each tool call (ask mode).' }
  if (!secretAllowedIn(tool)) {
    return { kind: 'block', reason: `A secret cannot go into ${shortName(tool)}: it would leave the vault (a message, memory or another service). Use it only where it is entered — a login form, an API call, a config file.` }
  }
  const r = resolvePlaceholders(input)
  if (r.missing.length > 0) {
    const have = listSecrets().map(s => `${s.name} (${s.fields.join(', ')})`).join('; ') || 'none'
    return { kind: 'block', reason: `Unknown secret ${r.missing.join(', ')}. Secrets in the vault: ${have}. Ask the owner to add it with /secret add <name>.` }
  }
  return { kind: 'replace', input: r.value as Record<string, unknown>, used: r.used }
}

/** PreToolUse: fill the placeholders in. */
export function secretInputHook(askMode: boolean) {
  return async (input: any) => {
    const d = decideSecretInput(String(input?.tool_name ?? ''), input?.tool_input, askMode)
    if (d.kind === 'none') return {}
    if (d.kind === 'block') return { decision: 'block' as const, reason: d.reason }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, updatedInput: d.input } }
  }
}

/** PostToolUse: take any secret value back out of what the tool returned. */
export function secretOutputHook() {
  return async (input: any) => {
    const out = redact(input?.tool_response)
    if (out === null) return {}
    return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, updatedToolOutput: out } }
  }
}
