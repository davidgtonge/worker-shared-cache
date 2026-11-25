const { test } = require('node:test')
const assert = require('node:assert/strict')
const { openCache } = require('..')

const MB = 1 << 20

test('maxEntryBytes is about maxBytes / shards, less 192 bytes of bookkeeping', () => {
  const cache = openCache('limit-default', 64 * MB)
  assert.equal(cache.shards, 64, 'the default is 64 on every machine')
  assert.equal(cache.maxEntryBytes, Math.floor(((64 * MB) / 64) * 0.97) - 192)
})

test('an entry at maxEntryBytes is stored; one byte more throws', () => {
  const cache = openCache('limit-edge', MB, { shards: 4 })
  const room = cache.maxEntryBytes - 1 // the key 'k' takes one byte
  cache.setBuffer('k', Buffer.alloc(room))
  assert.equal(cache.getBuffer('k').length, room)
  assert.throws(() => cache.setBuffer('k', Buffer.alloc(room + 1)), RangeError)
})

test('an oversized set throws and drops the older value', () => {
  const cache = openCache('limit-drop', MB, { shards: 4 })
  cache.set('k', 'small')
  assert.throws(() => cache.set('k', 'x'.repeat(cache.maxEntryBytes)), /over this cache's maxEntryBytes/)
  assert.equal(cache.get('k'), undefined)
  cache.setBuffer('b', Buffer.from('small'))
  assert.throws(() => cache.setBuffer('b', Buffer.alloc(cache.maxEntryBytes)), RangeError)
  assert.equal(cache.getBuffer('b'), undefined)
})

test('fewer shards allow bigger entries', () => {
  const cache = openCache('one-shard', 4 * MB, { shards: 1 })
  assert.equal(cache.shards, 1)
  cache.setBuffer('big', Buffer.alloc(3 * MB))
  assert.equal(cache.getBuffer('big').length, 3 * MB)
})

test('shards round up to a power of two', () => {
  assert.equal(openCache('shards-3', 16 * MB, { shards: 3 }).shards, 4)
})

test('reopening needs the same maxBytes and options, in effect', () => {
  openCache('reopen', 4 * MB, { shards: 3 })
  assert.ok(openCache('reopen', 4 * MB, { shards: 3 }))
  assert.ok(openCache('reopen', 4 * MB, { shards: 4 }), '3 and 4 both give 4 shards')
  assert.throws(() => openCache('reopen', 8 * MB, { shards: 3 }), /already open with maxBytes 4194304, 4 shards, hotAllocation 0.97; asked for maxBytes 8388608, 4 shards/)
  assert.throws(() => openCache('reopen', 4 * MB, { shards: 16 }), /already open/)
  assert.throws(() => openCache('reopen', 4 * MB), /already open/)
})

test('reopening with identical options always succeeds, whatever the shard reduction', () => {
  // The reopen check predicts the shard count quick_cache settles on; this catches the two disagreeing.
  for (const maxBytes of [1000, 4096, 100_000, 1e6, 64 * MB, 1e12]) {
    for (const options of [{}, { shards: 1 }, { shards: 7 }, { shards: 65536 }, { estimatedEntryBytes: 1 }, { estimatedEntryBytes: 1e7 }]) {
      const name = `identical-${maxBytes}-${JSON.stringify(options)}`
      let first
      try {
        first = openCache(name, maxBytes, options)
      } catch (error) {
        assert.ok(error instanceof RangeError, `${name}: ${error.message}`)
        continue
      }
      assert.equal(openCache(name, maxBytes, options).shards, first.shards, name)
    }
  }
})

test('estimatedEntryBytes can lower the shard count, which raises maxEntryBytes', () => {
  const small = openCache('estimate-default', 1e6)
  const large = openCache('estimate-large', 1e6, { estimatedEntryBytes: 1e7 })
  assert.ok(large.shards < small.shards)
  assert.ok(large.maxEntryBytes > small.maxEntryBytes)
})

test('a maxBytes too small for any entry is a RangeError', () => {
  assert.throws(() => openCache('too-small', 100), { name: 'RangeError', message: /leaves no room for an entry/ })
  assert.ok(openCache('just-enough', 1000).maxEntryBytes > 0)
})

test('options are read once, including from a prototype, and checked as read', () => {
  assert.equal(openCache('inherited', 1e6, Object.create({ shards: 2 })).shards, 2)
  assert.throws(() => openCache('inherited-bad', 1e6, Object.create({ shards: 'x' })), {
    name: 'TypeError',
    message: 'shards must be a number, got string',
  })
  let reads = 0
  const flipping = { get shards() { return reads++ === 0 ? 2 : 'x' } }
  assert.equal(openCache('getter', 1e6, flipping).shards, 2)
  assert.equal(reads, 1)
})

test('leaving options out matches opening with the defaults', () => {
  openCache('reopen-defaults', 4 * MB)
  assert.ok(openCache('reopen-defaults', 4 * MB, { hotAllocation: 0.97, estimatedEntryBytes: 1024 }))
})

test('invalid options throw RangeError, showing the value as JS writes it', () => {
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => openCache(`bad-max-${maxBytes}`, maxBytes), { name: 'RangeError', message: new RegExp(`maxBytes must be a whole number from 1 to 9007199254740991, got ${String(maxBytes).replace('.', '\\.')}$`) })
  }
  for (const shards of [0, -1, 4.5, 2 ** 32, NaN]) {
    assert.throws(() => openCache(`bad-shards-${shards}`, MB, { shards }), { name: 'RangeError', message: /shards must be a whole number from 1 to 65536/ })
  }
  assert.throws(() => openCache('bad-huge', MB, { estimatedEntryBytes: 1e300 }), /got 1e\+300$/)
  for (const hotAllocation of [0, 1.5, -0.1]) {
    assert.throws(() => openCache(`bad-hot-${hotAllocation}`, MB, { hotAllocation }), /hotAllocation/)
  }
  assert.throws(() => openCache('bad-entry', MB, { estimatedEntryBytes: 0 }), /estimatedEntryBytes/)
})
