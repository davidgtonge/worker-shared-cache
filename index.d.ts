export interface CacheOptions {
  /**
   * How many independent parts the cache is split into, so threads rarely wait on each other. Each part
   * holds an equal share of `maxBytes`, which caps the size of one entry (see `maxEntryBytes`). Rounded
   * up to a power of two, and lowered for caches too small to fill that many. Default: CPU count × 4.
   */
  shards?: number
  /**
   * The share of each part (above 0, at most 1) kept for entries read more than once; the rest holds new
   * entries on probation. Lower it if recent entries matter more than frequent ones. Default: 0.97.
   */
  hotAllocation?: number
  /** Typical bytes per entry, used only to size internal tables. Default: 1024. */
  estimatedEntryBytes?: number
}

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
  private constructor()
  /** The value stored by `set`, parsed from JSON, or `undefined` on a miss. */
  get<T = unknown>(key: string): T | undefined
  /**
   * Stores `JSON.stringify(value)`. Throws a TypeError for values with no JSON form, such as `undefined`
   * or a function, and a RangeError when the entry is over `maxEntryBytes`.
   */
  set(key: string, value: unknown): void
  /** The raw bytes stored under `key` (by either setter), or `undefined` on a miss. */
  getBuffer(key: string): Buffer | undefined
  /** Stores a copy of the bytes. Throws a RangeError when the entry is over `maxEntryBytes`. */
  setBuffer(key: string, value: ArrayBufferView): void
  /**
   * Raw lookups for many keys in one call, returned as one Buffer: per key a u32 LE length followed by
   * that many bytes, or 0xffffffff and no bytes for a miss.
   */
  getPacked(keys: string[]): Buffer
  stats(): Stats
  /** The largest key + value, in bytes, this cache accepts: about `maxBytes / shards`. */
  readonly maxEntryBytes: number
  /** The number of shards in use, after rounding. */
  readonly shards: number
}

/**
 * Opens the named cache, creating it on first use. Every worker thread that opens the same name shares it.
 * Throws if the name is already open with a different `maxBytes` or options.
 */
export declare function openCache(name: string, maxBytes: number, options?: CacheOptions): SharedCache
