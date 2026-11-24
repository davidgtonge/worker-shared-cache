const { test } = require('node:test')
const assert = require('node:assert/strict')
const { openCache } = require('..')

const MB = 1 << 20

function unpack(buf) {
  const out = []
  for (let at = 0; at < buf.length; ) {
    const len = buf.readUInt32LE(at)
    at += 4
    if (len === 0xffffffff) {
      out.push(undefined)
      continue
    }
    out.push(buf.subarray(at, at + len))
    at += len
  }
  return out
}

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

test('getPacked returns lengths, bytes and misses', () => {
  const cache = openCache('packed', MB)
  cache.setBuffer('x', Buffer.from('xx'))
  cache.setBuffer('z', Buffer.alloc(0))
  const [x, y, z] = unpack(cache.getPacked(['x', 'y', 'z']))
  assert.equal(x.toString(), 'xx')
  assert.equal(y, undefined)
  assert.equal(z.length, 0)
})

test('getPacked of no keys is an empty Buffer', () => {
  assert.equal(openCache('packed-empty', MB).getPacked([]).length, 0)
})

test('getPacked keeps large values intact and in key order', () => {
  const cache = openCache('packed-large', 64 * MB, { shards: 4 })
  const sizes = [0, 1, 300_000, 65_536, 1_000_000]
  sizes.forEach((n, i) => cache.setBuffer(`big${i}`, Buffer.alloc(n, i + 1)))
  const keys = sizes.flatMap((_, i) => [`big${i}`, `absent${i}`])
  const values = unpack(cache.getPacked(keys))
  assert.equal(values.length, keys.length)
  sizes.forEach((n, i) => {
    const value = values[2 * i]
    assert.equal(value.length, n)
    assert.ok(value.every((byte) => byte === i + 1), `big${i} holds only byte ${i + 1}`)
    assert.equal(values[2 * i + 1], undefined)
  })
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
