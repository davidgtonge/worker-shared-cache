const { test } = require('node:test')
const assert = require('node:assert/strict')
const { openCache } = require('..')

const MB = 1 << 20

test('get and set round-trip values through JSON', () => {
  const cache = openCache('json', MB)
  const user = { id: 1, name: 'Ada', tags: ['x'], nested: { ok: true }, score: 1.5 }
  cache.set('user', user)
  assert.deepEqual(cache.get('user'), user)
  assert.notEqual(cache.get('user'), user, 'returns a fresh copy')
  for (const value of [0, '', false, null, 'héllo ✓ 漢字', [1, 2]]) {
    cache.set('v', value)
    assert.deepEqual(cache.get('v'), value)
  }
})

test('get returns undefined on a miss, distinct from a stored null', () => {
  const cache = openCache('json-miss', MB)
  assert.equal(cache.get('nope'), undefined)
  cache.set('null', null)
  assert.equal(cache.get('null'), null)
})

test('set throws for values with no JSON form', () => {
  const cache = openCache('json-invalid', MB)
  assert.throws(() => cache.set('u', undefined), TypeError)
  assert.throws(() => cache.set('f', () => {}), TypeError)
  assert.throws(() => cache.set('b', 1n), TypeError)
})

test('JSON and raw views share one store', () => {
  const cache = openCache('json-mixed', MB)
  cache.set('j', { a: 1 })
  assert.equal(cache.getBuffer('j').toString(), '{"a":1}')
  cache.setBuffer('b', Buffer.from('[1,2]'))
  assert.deepEqual(cache.get('b'), [1, 2])
  cache.setBuffer('bin', Buffer.from([0xff, 0xfe]))
  assert.throws(() => cache.get('bin'), /not UTF-8/)
})
