const { test } = require('node:test')
const assert = require('node:assert/strict')
const { openCache } = require('..')

const MB = 1 << 20

test('getBuffer and setBuffer store raw bytes', () => {
  const cache = openCache('raw', MB)
  assert.equal(cache.getBuffer('a'), undefined)
  cache.setBuffer('a', Buffer.from('hello'))
  assert.equal(cache.getBuffer('a').toString(), 'hello')
  cache.setBuffer('u8', new Uint8Array([1, 2, 3]))
  assert.deepEqual([...cache.getBuffer('u8')], [1, 2, 3])
})

test('setBuffer rejects values that are not bytes', () => {
  const cache = openCache('raw-invalid', MB)
  assert.throws(() => cache.setBuffer('s', 'not bytes'), TypeError)
  assert.throws(() => cache.setBuffer('o', { a: 1 }), TypeError)
})

test('stats count hits and misses across methods', () => {
  const cache = openCache('stats', MB)
  cache.setBuffer('a', Buffer.from('hello'))
  cache.getBuffer('a')
  cache.get('missing')
  // bytes counts the key and value (6) plus 192 bytes of bookkeeping per entry.
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 6 + 192, hits: 1, misses: 1 })
})

test('an empty key with an empty value is weighed and evicted like any other entry', () => {
  // Before entries had a bookkeeping weight, this one weighed 0, and quick_cache never evicts those.
  const cache = openCache('zero-weight', 4096, { shards: 1 })
  for (let i = 0; i < 100; i++) cache.setBuffer(`before${i}`, Buffer.alloc(10)) // fill the cache first
  const bytesBefore = cache.stats().bytes
  cache.setBuffer('', new Uint8Array(0))
  assert.ok(cache.stats().bytes !== bytesBefore || cache.getBuffer('') === undefined, 'it has a weight')
  for (let i = 0; i < 1000; i++) cache.setBuffer(`after${i}`, Buffer.alloc(10))
  assert.equal(cache.getBuffer(''), undefined)
})

test('typed arrays and DataViews store exactly the bytes they view', () => {
  const cache = openCache('views', MB)
  const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  cache.setBuffer('slice', new Uint8Array(backing.buffer, 2, 3))
  assert.deepEqual([...cache.getBuffer('slice')], [2, 3, 4])
  cache.setBuffer('wide', new Uint16Array(backing.buffer, 4, 2))
  assert.deepEqual([...cache.getBuffer('wide')], [4, 5, 6, 7])
  cache.setBuffer('view', new DataView(backing.buffer, 10, 2))
  assert.deepEqual([...cache.getBuffer('view')], [10, 11])
})

test('evicts to stay within maxBytes', () => {
  const cache = openCache('bounded', 64 * 1024)
  for (let i = 0; i < 1000; i++) cache.setBuffer(`k${i}`, Buffer.alloc(512))
  assert.ok(cache.stats().bytes <= 64 * 1024)
})
