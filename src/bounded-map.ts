/**
 * A Map with a configurable max size.
 * When capacity is reached, the oldest entry is evicted.
 */
export class BoundedMap<K, V> {
  private map = new Map<K, V>()
  private readonly maxSize: number

  constructor(maxSize = 1000) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
    return this
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
