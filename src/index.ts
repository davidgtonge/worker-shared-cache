/// <reference types="node" preserve="true" />
// The declarations use Node's Buffer; this keeps the reference in lib/index.d.ts (preserve="true", since
// TypeScript 5.5) so @types/node loads even for projects that limit `types`.

import { markAsUncloneable } from 'node:worker_threads'
import { openCache as openNativeCache, type NativeCache } from './binding.js'

export interface CacheOptions {
  /**
   * How many independent parts the cache is split into, so threads rarely wait on each other. Each part
   * holds an equal share of `maxBytes`, which caps the size of one entry (see `maxEntryBytes`). A whole
   * number from 1 to 65536, rounded up to a power of two, and lowered for caches too small to give each
   * part room for about 32 entries. Default: 64, on every machine, so a cache accepts the same entries
   * wherever it runs.
   */
  shards?: number
  /**
   * The share of each part (above 0, at most 1) kept for entries read more than once; the rest holds new
   * entries on probation. Lower it if recent entries matter more than frequent ones. Default: 0.97.
   */
  hotAllocation?: number
  /**
   * Typical key + value bytes per entry. It sizes internal tables, and in a small cache it also lowers the
   * shard count so each shard has room for about 32 entries of this size, which raises `maxEntryBytes`.
   * Default: 1024.
   */
  estimatedEntryBytes?: number
}

export interface Stats {
  /** Entries currently held. */
  entries: number
  /** Bytes currently held: each entry's key and value plus about 192 bytes of bookkeeping. */
  bytes: number
  /** Lookups that found a value, across every thread and method. */
  hits: number
  /** Lookups that found nothing. */
  misses: number
}

const OPTIONS = ['shards', 'hotAllocation', 'estimatedEntryBytes'] as const satisfies readonly (keyof CacheOptions)[]


/**
 * A named cache shared by every worker thread in the process. Values go in either as JSON (`get`/`set`)
 * or as raw bytes (`getBuffer`/`setBuffer`); both read and write the same entries. Open one with
 * {@link openCache}, in each thread that uses it: a SharedCache can't be sent to another thread.
 */
export class SharedCache {
  // TypeScript `private`, not a `#native` field: `#` members appear in the declarations as `#private`,
  // which TypeScript 5 rejects in projects targeting ES5 (its default) unless they set skipLibCheck.
  private readonly native: NativeCache

  private constructor(cache: NativeCache) {
    this.native = cache
    // Makes postMessage(cache) throw instead of sending a copy with no methods. Node added it in 22.10, so
    // on earlier 22.x releases it is undefined despite its type.
    ;(markAsUncloneable as typeof markAsUncloneable | undefined)?.(this)
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
    const text = this.native.getString(key)
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
    if (!this.native.setBuffer(key, bytes)) this.tooLarge(key, bytes.length)
  }

  /**
   * The raw bytes stored under `key` (by either setter), or `undefined` on a miss. For binary data or your
   * own encoding; making the Buffer is the main cost of a read (~0.5 µs).
   */
  getBuffer(key: string): Buffer | undefined {
    checkKey(key)
    return this.native.getBuffer(key) ?? undefined
  }

  /** Stores a copy of the bytes. Throws a RangeError when the entry is over `maxEntryBytes`. */
  setBuffer(key: string, value: ArrayBufferView): void {
    checkKey(key)
    if (!ArrayBuffer.isView(value)) {
      throw new TypeError(`setBuffer expects a Buffer, typed array or DataView for '${key}'`)
    }
    // A view of a transferred ArrayBuffer reads as empty; storing that would silently lose the value.
    if (value.buffer instanceof ArrayBuffer && value.buffer.detached) {
      throw new TypeError(`setBuffer got a view of a detached (transferred) ArrayBuffer for '${key}'`)
    }
    // The native side reads any ArrayBufferView's bytes, though napi types the parameter as Buffer.
    if (!this.native.setBuffer(key, value as Buffer)) this.tooLarge(key, value.byteLength)
  }

  stats(): Stats {
    return this.native.stats()
  }

  /** The largest key + value, in bytes, this cache accepts: about `maxBytes / shards`. */
  get maxEntryBytes(): number {
    return this.native.maxEntryBytes
  }

  /** The number of shards in use, after rounding. */
  get shards(): number {
    return this.native.shards
  }

  private tooLarge(key: string, valueBytes: number): never {
    const bytes = Buffer.byteLength(key) + valueBytes
    throw new RangeError(
      `cannot cache '${key}': ${bytes} bytes (key + value) is over this cache's maxEntryBytes of ` +
        `${this.maxEntryBytes}. Raise maxBytes or lower shards to allow bigger entries.`,
    )
  }
}

/**
 * Opens the named cache, creating it on first use. Every worker thread that opens the same name shares it;
 * separate processes (cluster workers, child processes) each have their own.
 *
 * Throws a TypeError for arguments of the wrong type, a RangeError for out-of-range options (including a
 * `maxBytes` too small for any entry), and an Error if the name is already open with settings that differ
 * in effect. When threads open a new name at the same moment with conflicting options, the first one to
 * get there wins.
 */
export function openCache(name: string, maxBytes: number, options: CacheOptions = {}): SharedCache {
  // Types are checked here, for JS callers, so mistakes throw a TypeError naming the argument. Ranges are
  // checked natively (native/src/config.rs) and rethrown as RangeError.
  checkString('name', name)
  if (typeof maxBytes !== 'number') throw new TypeError(`maxBytes must be a number, got ${describe(maxBytes)}`)
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(`options must be an object, got ${describe(options)}`)
  }
  for (const option of Object.keys(options)) {
    if (!(OPTIONS as readonly string[]).includes(option)) {
      throw new TypeError(`unknown option '${option}'; expected one of ${OPTIONS.join(', ')}`)
    }
  }
  // Read each option once, into a plain object that is checked and then passed on as is, so a getter or a
  // value inherited from a prototype can't differ between the check and the native read.
  const settings: CacheOptions = {}
  for (const option of OPTIONS) {
    const value: unknown = options[option]
    if (value === undefined) continue
    if (typeof value !== 'number') throw new TypeError(`${option} must be a number, got ${describe(value)}`)
    settings[option] = value
  }
  let native: NativeCache
  try {
    native = openNativeCache(name, maxBytes, settings)
  } catch (error) {
    throw (error as { code?: unknown }).code === 'InvalidArg' ? new RangeError((error as Error).message) : error
  }
  return SharedCache.fromNative(native)
}

function checkKey(key: unknown): asserts key is string {
  checkString('key', key)
}

// Native code receives strings as UTF-8, which has no form for a lone surrogate: each one would become
// U+FFFD, so '\uD800' and '\uDC00' would name the same entry. Reject them instead.
function checkString(what: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string, got ${describe(value)}`)
  if (!value.isWellFormed()) throw new TypeError(`${what} must be well-formed UTF-16 (it has a lone surrogate)`)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'an array' : typeof value
}
