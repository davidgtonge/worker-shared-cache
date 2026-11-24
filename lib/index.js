'use strict'

const native = require('./binding.js')

/**
 * A named cache shared by every worker thread in the process. Values go in either as JSON (`get`/`set`)
 * or as raw bytes (`getBuffer`/`setBuffer`); both read and write the same entries. Types: index.d.ts (beside this file).
 */
class SharedCache {
  #native

  /** @param {import('./binding').NativeCache} cache */
  constructor(cache) {
    this.#native = cache
  }

  // Reads as a string, not a Buffer: JSON.parse needs a string, and the native side makes one straight
  // from the cached bytes, ~3.5x faster than getBuffer(key).toString(). See native/src/bindings.rs.
  get(key) {
    checkKey(key)
    const text = this.#native.getString(key)
    return text === null ? undefined : JSON.parse(text)
  }

  set(key, value) {
    checkKey(key)
    const text = JSON.stringify(value)
    if (text === undefined) {
      throw new TypeError(`cannot cache ${typeof value} under '${key}': it has no JSON form`)
    }
    const bytes = Buffer.from(text)
    if (!this.#native.setBuffer(key, bytes)) this.#tooLarge(key, bytes.length)
  }

  // For binary data or your own encoding. Making the Buffer is the main cost of a read (~0.5 µs).
  getBuffer(key) {
    checkKey(key)
    return this.#native.getBuffer(key) ?? undefined
  }

  setBuffer(key, value) {
    checkKey(key)
    if (!ArrayBuffer.isView(value)) {
      throw new TypeError(`setBuffer expects a Buffer, typed array or DataView for '${key}'`)
    }
    if (!this.#native.setBuffer(key, value)) this.#tooLarge(key, value.byteLength)
  }

  stats() {
    return this.#native.stats()
  }

  get maxEntryBytes() {
    return this.#native.maxEntryBytes
  }

  get shards() {
    return this.#native.shards
  }

  #tooLarge(key, valueBytes) {
    const bytes = Buffer.byteLength(key) + valueBytes
    throw new RangeError(
      `cannot cache '${key}': ${bytes} bytes (key + value) is over this cache's maxEntryBytes of ` +
        `${this.maxEntryBytes}. Raise maxBytes or lower shards to allow bigger entries.`,
    )
  }
}

const OPTIONS = ['shards', 'hotAllocation', 'estimatedEntryBytes']

// Types are checked here so mistakes throw a TypeError naming the argument. Ranges (whole numbers,
// limits) are checked natively, in native/src/config.rs.
function openCache(name, maxBytes, options = {}) {
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
  return new SharedCache(native.openCache(name, maxBytes, options))
}

function checkKey(key) {
  if (typeof key !== 'string') throw new TypeError(`key must be a string, got ${describe(key)}`)
}

function describe(value) {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'an array' : typeof value
}

module.exports = { openCache, SharedCache }
