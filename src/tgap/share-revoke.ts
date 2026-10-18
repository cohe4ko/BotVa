/**
 * Revoking a shared secret from the admin panel. The panel runs in another
 * process and cannot talk TGAP for the bot, so it only marks the share; the
 * bot's sweep sends the revoke within a minute. No config here: the panel
 * opens any bot's database itself.
 */

import type { DatabaseSync } from 'node:sqlite'

/** Outgoing share states still worth revoking: the peer has, or may get, the secret. */
export const REVOCABLE = ['awaiting_key', 'sent', 'delivered'] as const

export function addShareRevokeColumn(d: DatabaseSync): void {
  try { d.exec('ALTER TABLE tgap_secret_shares ADD COLUMN revoke_requested INTEGER') } catch { /* already there, or no table yet */ }
}

/** Mark an outgoing share for the bot to revoke. False if it is not revocable. */
export function requestShareRevoke(d: DatabaseSync, id: string): boolean {
  addShareRevokeColumn(d)
  const marks = REVOCABLE.map(() => '?').join(', ')
  return Number(d.prepare(`UPDATE tgap_secret_shares SET revoke_requested = ? WHERE id = ? AND direction = 'out' AND state IN (${marks})`)
    .run(Math.floor(Date.now() / 1000), id, ...REVOCABLE).changes) > 0
}
