import { openCache as openNativeCache, type NativeCache } from './binding.js'

export interface CacheOptions {
  /**
   * How many independent parts the cache is split into, so threads rarely wait on each other. Each part
   * holds an equal share of `maxBytes`, which caps the size of one entry (see `maxEntryBytes`). A whole
   * number from 1 to 65536, rounded up to a power of two, and lowered for caches too small to fill that
   * many. Default: CPU count × 4.
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

const OPTIONS: readonly string[] = ['shards', 'hotAllocation', 'estimatedEntryBytes'] satisfies (keyof CacheOptions)[]

/**
 * A named cache shared by every worker thread in the process. Values go in either as JSON (`get`/`set`)
 * or as raw bytes (`getBuffer`/`setBuffer`); both read and write the same entries. Open one with
 * {@link openCache}.
 */
export class SharedCache {
  readonly #native: NativeCache

  private constructor(cache: NativeCache) {
    this.#native = cache
  }

  /** @internal Used by {@link openCache}; not part of the public API. */
  static fromNative(cache: NativeCache): SharedCache {
    return new SharedCache(cache)
  }

  /** The value stored by `set`, parsed from JSON, or `undefined` on a miss. */
  get<T = unknown>(key: string): T | undefined {
    checkKey(key)
    // Reads as a string, not a Buffer: JSON.parse needs a string, and the native side makes one straight
    // from the cached bytes, ~3.5x faster than getBuffer(key).toString(). See native/src/bindings.rs.
    const text = this.#native.getString(key)
    return text === null ? undefined : (JSON.parse(text) as T)
  }

  /**
   * Stores `JSON.stringify(value)`. Throws a TypeError for values with no JSON form, such as `undefined`
   * or a function, and a RangeError when the entry is over `maxEntryBytes`.
   */
  set(key: string, value: unknown): void {
    checkKey(key)
    // JSON.stringify returns undefined for undefined, functions and symbols, though its types say string.
    const text = JSON.stringify(value) as string | undefined
    if (text === undefined) {
      throw new TypeError(`cannot cache ${typeof value} under '${key}': it has no JSON form`)
    }
    const bytes = Buffer.from(text)
    if (!this.#native.setBuffer(key, bytes)) this.#tooLarge(key, bytes.length)
  }

  /**
   * The raw bytes stored under `key` (by either setter), or `undefined` on a miss. For binary data or your
   * own encoding; making the Buffer is the main cost of a read (~0.5 µs).
   */
  getBuffer(key: string): Buffer | undefined {
    checkKey(key)
    return this.#native.getBuffer(key) ?? undefined
  }

  /** Stores a copy of the bytes. Throws a RangeError when the entry is over `maxEntryBytes`. */
  setBuffer(key: string, value: ArrayBufferView): void {
    checkKey(key)
    if (!ArrayBuffer.isView(value)) {
      throw new TypeError(`setBuffer expects a Buffer, typed array or DataView for '${key}'`)
    }
    // The native side reads any ArrayBufferView's bytes, though napi types the parameter as Buffer.
    if (!this.#native.setBuffer(key, value as Buffer)) this.#tooLarge(key, value.byteLength)
  }

  stats(): Stats {
    return this.#native.stats()
  }

  /** The largest key + value, in bytes, this cache accepts: about `maxBytes / shards`. */
  get maxEntryBytes(): number {
    return this.#native.maxEntryBytes
  }

  /** The number of shards in use, after rounding. */
  get shards(): number {
    return this.#native.shards
  }

  #tooLarge(key: string, valueBytes: number): never {
    const bytes = Buffer.byteLength(key) + valueBytes
    throw new RangeError(
      `cannot cache '${key}': ${bytes} bytes (key + value) is over this cache's maxEntryBytes of ` +
        `${this.maxEntryBytes}. Raise maxBytes or lower shards to allow bigger entries.`,
    )
  }
}

/**
 * Opens the named cache, creating it on first use. Every worker thread that opens the same name shares it.
 * Throws if the name is already open with a different `maxBytes` or options.
 */
export function openCache(name: string, maxBytes: number, options: CacheOptions = {}): SharedCache {
  // Types are checked here too, for JS callers, so mistakes throw a TypeError naming the argument. Ranges
  // (whole numbers, limits) are checked natively, in native/src/config.rs.
  if (typeof name !== 'string') throw new TypeError(`name must be a string, got ${describe(name)}`)
  if (typeof maxBytes !== 'number') throw new TypeError(`maxBytes must be a number, got ${describe(maxBytes)}`)
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(`options must be an object, got ${describe(options)}`)
  }
  for (const [option, value] of Object.entries(options)) {
    if (!OPTIONS.includes(option)) {
      throw new TypeError(`unknown option '${option}'; expected one of ${OPTIONS.join(', ')}`)
    }
    if (value !== undefined && typeof value !== 'number') {
      throw new TypeError(`${option} must be a number, got ${describe(value)}`)
    }
  }
  return SharedCache.fromNative(openNativeCache(name, maxBytes, options))
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') throw new TypeError(`key must be a string, got ${describe(key)}`)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'an array' : typeof value
}
