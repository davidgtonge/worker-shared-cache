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

  get(key) {
    const text = this.#native.getString(key)
    return text === null ? undefined : JSON.parse(text)
  }

  set(key, value) {
    const text = JSON.stringify(value)
    if (text === undefined) {
      throw new TypeError(`cannot cache ${typeof value} under '${key}': it has no JSON form`)
    }
    if (!this.#native.setString(key, text)) this.#tooLarge(key, Buffer.byteLength(text))
  }

  getBuffer(key) {
    return this.#native.getBuffer(key) ?? undefined
  }

  setBuffer(key, value) {
    if (!ArrayBuffer.isView(value)) {
      throw new TypeError(`setBuffer expects a Buffer, typed array or DataView for '${key}'`)
    }
    if (!this.#native.setBuffer(key, value)) this.#tooLarge(key, value.byteLength)
  }

  getPacked(keys) {
    return this.#native.getPacked(keys)
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

function openCache(name, maxBytes, options) {
  return new SharedCache(native.openCache(name, maxBytes, options))
}

module.exports = { openCache, SharedCache }
