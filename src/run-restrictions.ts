/**
 * Restricted agent runs — an allowlist of tools, enforced three times over.
 *
 * Some runs act on text that someone other than the owner wrote: a guest query
 * answered in a foreign chat, a request from another owner's bot. Such a run
 * must not be able to do anything the allowlist does not name, even if the text
 * talks the model into trying. A single gate is not enough for that, because
 * each SDK mechanism has a hole on its own:
 *
 * - `tools` limits the built-in tools, but says nothing about MCP tools;
 * - `permissionMode: 'dontAsk'` denies whatever is not pre-approved, but the
 *   owner's own settings.json (loaded via settingSources) can pre-approve more;
 * - a PreToolUse hook sees every call, MCP included, and runs before any
 *   permission rule — this is the layer that actually holds.
 *
 * All three are set together, so a mistake in one of them is caught by the next.
 */

/** Built-in SDK tools that never belong in a restricted run, whatever the allowlist says. */
const NEVER_ALLOWED = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task'])

export interface RunRestrictions {
  /**
   * Tools the run may call, by the name the model sees: `WebSearch` for a
   * built-in, `mcp__builtin__SearchMemory` for an MCP tool. `mcp__server__*`
   * allows every tool of one server.
   */
  allowTools: string[]
}

/** The full name the model sees for a BotVa builtin tool. */
export function builtinToolId(name: string): string {
  return `mcp__builtin__${name}`
}

/** Whether `toolName` is covered by the allowlist. */
export function isToolAllowed(toolName: string, allow: string[]): boolean {
  if (!toolName || NEVER_ALLOWED.has(toolName)) return false
  for (const rule of allow) {
    if (rule === toolName) return true
    if (rule.endsWith('__*') && rule.startsWith('mcp__') && toolName.startsWith(rule.slice(0, -1))) return true
  }
  return false
}

/** Built-in (non-MCP) tools named by the allowlist, minus the ones never allowed. */
export function builtinToolsOf(allow: string[]): string[] {
  return allow.filter(t => !t.startsWith('mcp__') && !NEVER_ALLOWED.has(t))
}

/**
 * Query options that confine a run to `allowTools`.
 *
 * Spread over the regular options last, so nothing set earlier — plan or ask
 * hooks, a bypass permission mode — survives into a restricted run.
 */
export function buildRestrictedOptions(r: RunRestrictions) {
  const allow = r.allowTools.filter(t => !NEVER_ALLOWED.has(t))
  return {
    tools: builtinToolsOf(allow),
    allowedTools: allow,
    permissionMode: 'dontAsk' as const,
    allowDangerouslySkipPermissions: false,
    hooks: {
      PreToolUse: [{
        hooks: [async (input: any) => {
          const toolName = String(input?.tool_name ?? '')
          if (isToolAllowed(toolName, allow)) return { decision: 'approve' as const }
          return { decision: 'block' as const, reason: `${toolName} is not available in this restricted run.` }
        }],
      }],
    },
  }
}
