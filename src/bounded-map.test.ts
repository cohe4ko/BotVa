import { describe, it, expect } from 'vitest'
import { BoundedMap } from './bounded-map.js'

describe('BoundedMap', () => {
  it('set and get', () => {
    const map = new BoundedMap<string, number>(10)
    map.set('a', 1)
    expect(map.get('a')).toBe(1)
  })

  it('returns undefined for missing key', () => {
    const map = new BoundedMap<string, number>(10)
    expect(map.get('x')).toBeUndefined()
  })

  it('evicts oldest entry when full (FIFO)', () => {
    const map = new BoundedMap<string, number>(2)
    map.set('a', 1)
    map.set('b', 2)
    map.set('c', 3)
    expect(map.has('a')).toBe(false)
    expect(map.get('b')).toBe(2)
    expect(map.get('c')).toBe(3)
    expect(map.size).toBe(2)
  })

  it('updating existing key does not increase size', () => {
    const map = new BoundedMap<string, number>(2)
    map.set('a', 1)
    map.set('b', 2)
    map.set('a', 10) // update, not insert
    expect(map.size).toBe(2)
    expect(map.get('a')).toBe(10)
    // 'b' should still exist — no eviction needed
    expect(map.has('b')).toBe(true)
  })

  it('delete removes entry', () => {
    const map = new BoundedMap<string, number>(10)
    map.set('a', 1)
    expect(map.delete('a')).toBe(true)
    expect(map.has('a')).toBe(false)
    expect(map.size).toBe(0)
  })

  it('clear removes all entries', () => {
    const map = new BoundedMap<string, number>(10)
    map.set('a', 1)
    map.set('b', 2)
    map.clear()
    expect(map.size).toBe(0)
    expect(map.has('a')).toBe(false)
  })

  it('set returns this for chaining', () => {
    const map = new BoundedMap<string, number>(10)
    const result = map.set('a', 1)
    expect(result).toBe(map)
  })

  it('uses default maxSize of 1000', () => {
    const map = new BoundedMap<string, number>()
    for (let i = 0; i < 1001; i++) {
      map.set(`key${i}`, i)
    }
    expect(map.size).toBe(1000)
    expect(map.has('key0')).toBe(false)
    expect(map.has('key1')).toBe(true)
  })
})
