/**
 * Telegram Observer — which tools put something in front of another person.
 *
 * Kept apart from mcp.ts so the bot process can read the list without pulling
 * in the daemon's database and MTProto client, and kept in one place because
 * the list is a rule ("anything that speaks from the owner's account") that a
 * new tool must be added to. `tool-names.test.ts` fails if one is forgotten.
 */

export const TELEGRAM_MCP_SERVER = 'telegram'

/**
 * Tools that emit a message into someone else's chat.
 *
 * Withheld from unattended runs — a scheduled agent works at three in the
 * morning with nobody watching, and a message sent from the owner's own account
 * cannot be recalled. Reading, and even editing the owner's private notes and
 * contacts, is reversible and stays inside his account; speaking to another
 * person is neither.
 */
export const TELEGRAM_SENDING_TOOLS = [
  'tg_send_message',
  'tg_send_file',
  'tg_send_contact',
] as const

/** SDK tool identifier for an MCP tool: how disallowedTools names them. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

/** The sending tools as the agent SDK names them. */
export function telegramSendingToolIds(): string[] {
  return TELEGRAM_SENDING_TOOLS.map(t => mcpToolName(TELEGRAM_MCP_SERVER, t))
}
