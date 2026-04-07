import { describe, it, expect } from 'vitest'

// Regression: src/publish.ts used `__dirname` without an ESM shim,
// which crashed at module load with:
//   "ReferenceError: __dirname is not defined in ES module scope"
// Importing the module is enough to catch the bug — evaluation itself
// throws if the shim is missing.
describe('publish module loads in ESM', () => {
  it('imports without ReferenceError on __dirname', async () => {
    const mod = await import('./publish.js')
    expect(typeof mod.publishFile).toBe('function')
  })
})
