const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const { openCache } = require('..')

const MB = 1 << 20

test('maxEntryBytes is about maxBytes / shards', () => {
  const cache = openCache('limit-default', 64 * MB)
  const expectedShards = 2 ** Math.ceil(Math.log2(os.availableParallelism() * 4))
  assert.equal(cache.shards, expectedShards)
  assert.equal(cache.maxEntryBytes, Math.floor(((64 * MB) / expectedShards) * 0.97))
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

test('reopening needs the same maxBytes and options', () => {
  // 3 shards can never equal the default (a multiple of 4), so reopening without options must differ.
  openCache('reopen', 4 * MB, { shards: 3 })
  assert.ok(openCache('reopen', 4 * MB, { shards: 3 }))
  assert.throws(() => openCache('reopen', 8 * MB, { shards: 3 }), /already open with maxBytes 4194304, shards 3/)
  assert.throws(() => openCache('reopen', 4 * MB, { shards: 16 }), /already open/)
  assert.throws(() => openCache('reopen', 4 * MB), /already open/)
})

test('leaving options out matches opening with the defaults', () => {
  openCache('reopen-defaults', 4 * MB)
  assert.ok(openCache('reopen-defaults', 4 * MB, { hotAllocation: 0.97, estimatedEntryBytes: 1024 }))
})

test('invalid options throw', () => {
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => openCache(`bad-max-${maxBytes}`, maxBytes), /maxBytes must be a whole number/)
  }
  for (const shards of [0, -1, 4.5, 2 ** 32, NaN]) {
    assert.throws(() => openCache(`bad-shards-${shards}`, MB, { shards }), /shards must be a whole number from 1 to 65536/)
  }
  for (const hotAllocation of [0, 1.5, -0.1]) {
    assert.throws(() => openCache(`bad-hot-${hotAllocation}`, MB, { hotAllocation }), /hotAllocation/)
  }
  assert.throws(() => openCache('bad-entry', MB, { estimatedEntryBytes: 0 }), /estimatedEntryBytes/)
})
