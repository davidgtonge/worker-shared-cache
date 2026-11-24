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
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 6, hits: 1, misses: 1 })
})

test('evicts to stay within maxBytes', () => {
  const cache = openCache('bounded', 64 * 1024)
  for (let i = 0; i < 1000; i++) cache.setBuffer(`k${i}`, Buffer.alloc(512))
  assert.ok(cache.stats().bytes <= 64 * 1024)
})
