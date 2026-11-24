const { test } = require('node:test')
const assert = require('node:assert/strict')
const { openCache } = require('..')

const MB = 1 << 20

test('keys must be strings', () => {
  const cache = openCache('arguments', MB)
  for (const key of [123, undefined, null, {}, ['a'], Symbol('k')]) {
    assert.throws(() => cache.get(key), { name: 'TypeError', message: /^key must be a string/ })
    assert.throws(() => cache.set(key, 1), { name: 'TypeError', message: /^key must be a string/ })
    assert.throws(() => cache.getBuffer(key), { name: 'TypeError', message: /^key must be a string/ })
    assert.throws(() => cache.setBuffer(key, Buffer.alloc(1)), { name: 'TypeError', message: /^key must be a string/ })
  }
  assert.throws(() => cache.get(null), /got null/)
  assert.throws(() => cache.get([]), /got an array/)
})

test('openCache checks the types of its arguments', () => {
  assert.throws(() => openCache(1, MB), { name: 'TypeError', message: 'name must be a string, got number' })
  assert.throws(() => openCache('t', '10'), { name: 'TypeError', message: 'maxBytes must be a number, got string' })
  assert.throws(() => openCache('t', undefined), { name: 'TypeError', message: /maxBytes must be a number/ })
  for (const options of [null, 5, 'x', []]) {
    assert.throws(() => openCache('t', MB, options), { name: 'TypeError', message: /^options must be an object/ })
  }
  assert.throws(() => openCache('t', MB, { shards: '4' }), {
    name: 'TypeError',
    message: 'shards must be a number, got string',
  })
})

test('unknown options are rejected, catching typos', () => {
  assert.throws(() => openCache('t', MB, { shard: 8 }), {
    name: 'TypeError',
    message: "unknown option 'shard'; expected one of shards, hotAllocation, estimatedEntryBytes",
  })
})

test('options set to undefined take their defaults', () => {
  const cache = openCache('undefined-options', MB, { shards: undefined, hotAllocation: undefined })
  assert.ok(openCache('undefined-options', MB))
  assert.ok(cache.shards >= 1)
})
