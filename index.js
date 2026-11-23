'use strict'

const native = require('./binding.js')

/** A named cache shared by every worker thread in the process. See index.d.ts for the API. */
class SharedCache {
  #native

  constructor(cache) {
    this.#native = cache
  }

  get(key) {
    const text = this.#native.getString(key)
    return text === null ? undefined : JSON.parse(text)
  }

  set(key, value) {
    const text = JSON.stringify(value)
    if (text === undefined) throw new TypeError(`cannot store ${typeof value} under '${key}': it has no JSON form`)
    this.#native.setString(key, text)
  }

  getBuffer(key) {
    return this.#native.getBuffer(key) ?? undefined
  }

  setBuffer(key, value) {
    if (!ArrayBuffer.isView(value)) {
      throw new TypeError(`setBuffer expects a Buffer, typed array or DataView for '${key}'`)
    }
    this.#native.setBuffer(key, value)
  }

  getPacked(keys) {
    return this.#native.getPacked(keys)
  }

  stats() {
    return this.#native.stats()
  }
}

function openCache(name, maxBytes) {
  return new SharedCache(native.openCache(name, maxBytes))
}

module.exports = { openCache, SharedCache }
