import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { addShareRevokeColumn, requestShareRevoke } from './share-revoke.js'

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`CREATE TABLE tgap_secret_shares (id TEXT PRIMARY KEY, direction TEXT, state TEXT);
    INSERT INTO tgap_secret_shares VALUES ('out-live', 'out', 'sent'), ('out-done', 'out', 'revoked'), ('in', 'in', 'accepted')`)
  return d
}

describe('share-revoke', () => {
  it('marks only live outgoing shares', () => {
    const d = db()
    expect(requestShareRevoke(d, 'out-live')).toBe(true)
    expect(requestShareRevoke(d, 'out-done')).toBe(false)
    expect(requestShareRevoke(d, 'in')).toBe(false)
    expect(requestShareRevoke(d, 'missing')).toBe(false)
  })

  it('adds the column once and survives a database without TGAP', () => {
    const d = db()
    addShareRevokeColumn(d)
    expect(() => addShareRevokeColumn(d)).not.toThrow()
    expect(() => addShareRevokeColumn(new DatabaseSync(':memory:'))).not.toThrow()
  })
})
