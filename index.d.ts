export interface Stats {
  /** Entries currently held. */
  entries: number
  /** Bytes currently held, counting each key and value. */
  bytes: number
  /** Lookups that found a value, across every thread and method. */
  hits: number
  /** Lookups that found nothing. */
  misses: number
}

export declare class SharedCache {
  /** The value stored by `set`, parsed from JSON, or `undefined` on a miss. */
  get<T = unknown>(key: string): T | undefined
  /** Stores `JSON.stringify(value)`. Throws for values with no JSON form, such as `undefined` or a function. */
  set(key: string, value: unknown): void
  /** The raw bytes stored under `key` (by either setter), or `undefined` on a miss. */
  getBuffer(key: string): Buffer | undefined
  /** Stores a copy of the bytes. */
  setBuffer(key: string, value: ArrayBufferView): void
  /**
   * Raw lookups for many keys in one call, returned as one Buffer: per key a u32 LE length followed by
   * that many bytes, or 0xffffffff and no bytes for a miss.
   */
  getPacked(keys: string[]): Buffer
  stats(): Stats
}

/**
 * Opens the named cache, creating it on first use. Every worker thread that opens the same name shares it.
 * Throws if the name is already open with a different `maxBytes`.
 */
export declare function openCache(name: string, maxBytes: number): SharedCache
