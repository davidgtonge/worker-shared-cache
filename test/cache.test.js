const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')
const { openCache } = require('..')

function unpack(buf) {
  const out = []
  let at = 0
  while (at < buf.length) {
    const len = buf.readUInt32LE(at)
    at += 4
    if (len === 0xffffffff) { out.push(undefined); continue }
    out.push(buf.subarray(at, at + len))
    at += len
  }
  return out
}

test('get and set round-trip values through JSON', () => {
  const cache = openCache('json', 1 << 20)
  const user = { id: 1, name: 'Ada', tags: ['x'], nested: { ok: true }, score: 1.5 }
  cache.set('user', user)
  assert.deepEqual(cache.get('user'), user)
  assert.notEqual(cache.get('user'), user, 'returns a fresh copy')
  for (const v of [0, '', false, null, 'héllo ✓ 漢字', [1, 2]]) {
    cache.set('v', v)
    assert.deepEqual(cache.get('v'), v)
  }
})

test('get returns undefined on a miss, distinct from a stored null', () => {
  const cache = openCache('miss', 1 << 20)
  assert.equal(cache.get('nope'), undefined)
  cache.set('null', null)
  assert.equal(cache.get('null'), null)
})

test('set throws for values with no JSON form', () => {
  const cache = openCache('bad-json', 1 << 20)
  assert.throws(() => cache.set('u', undefined), TypeError)
  assert.throws(() => cache.set('f', () => {}), TypeError)
  assert.throws(() => cache.set('b', 1n), TypeError)
})

test('getBuffer and setBuffer store raw bytes', () => {
  const cache = openCache('raw', 1 << 20)
  assert.equal(cache.getBuffer('a'), undefined)
  cache.setBuffer('a', Buffer.from('hello'))
  assert.equal(cache.getBuffer('a').toString(), 'hello')
  cache.setBuffer('u8', new Uint8Array([1, 2, 3]))
  assert.deepEqual([...cache.getBuffer('u8')], [1, 2, 3])
  assert.throws(() => cache.setBuffer('s', 'not bytes'), TypeError)
  assert.throws(() => cache.setBuffer('o', { a: 1 }), TypeError)
})

test('the two views share one store', () => {
  const cache = openCache('mixed', 1 << 20)
  cache.set('j', { a: 1 })
  assert.equal(cache.getBuffer('j').toString(), '{"a":1}')
  cache.setBuffer('b', Buffer.from('[1,2]'))
  assert.deepEqual(cache.get('b'), [1, 2])
  cache.setBuffer('bin', Buffer.from([0xff, 0xfe]))
  assert.throws(() => cache.get('bin'), /not UTF-8/)
})

test('stats count hits and misses across methods', () => {
  const cache = openCache('stats', 1 << 20)
  cache.setBuffer('a', Buffer.from('hello'))
  cache.getBuffer('a')
  cache.get('missing')
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 6, hits: 1, misses: 1 })
})

test('reopening with another size throws', () => {
  openCache('sized', 4096)
  assert.ok(openCache('sized', 4096))
  assert.throws(() => openCache('sized', 8192), /already open with maxBytes 4096/)
})

test('getPacked returns lengths, bytes and misses', () => {
  const cache = openCache('packed', 1 << 20)
  cache.setBuffer('x', Buffer.from('xx'))
  cache.setBuffer('z', Buffer.alloc(0))
  const [x, y, z] = unpack(cache.getPacked(['x', 'y', 'z']))
  assert.equal(x.toString(), 'xx')
  assert.equal(y, undefined)
  assert.equal(z.length, 0)
})

test('evicts to stay within maxBytes', () => {
  const cache = openCache('bounded', 64 * 1024)
  for (let i = 0; i < 1000; i++) cache.setBuffer(`k${i}`, Buffer.alloc(1024))
  assert.ok(cache.stats().bytes <= 64 * 1024)
})

test('worker threads share the same cache', async () => {
  openCache('shared', 1 << 20).set('from-main', { hi: 'there' })
  const code = `
    const { parentPort } = require('node:worker_threads')
    const cache = require(${JSON.stringify(require.resolve('..'))}).openCache('shared', 1 << 20)
    cache.set('from-worker', [1, 2, 3])
    parentPort.postMessage(cache.get('from-main'))
  `
  const seen = await new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true })
    w.once('message', resolve).once('error', reject)
  })
  assert.deepEqual(seen, { hi: 'there' })
  assert.deepEqual(openCache('shared', 1 << 20).get('from-worker'), [1, 2, 3])
})
