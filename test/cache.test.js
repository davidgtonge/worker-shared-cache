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

test('get, set and stats', () => {
  const cache = openCache('basic', 1 << 20)
  assert.equal(cache.get('a'), null)
  cache.set('a', Buffer.from('hello'))
  assert.equal(cache.get('a').toString(), 'hello')
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 6, hits: 1, misses: 1 })
})

test('reopening with another size throws', () => {
  openCache('sized', 4096)
  assert.ok(openCache('sized', 4096))
  assert.throws(() => openCache('sized', 8192), /already open with maxBytes 4096/)
})

test('getPacked returns lengths, bytes and misses', () => {
  const cache = openCache('packed', 1 << 20)
  cache.set('x', Buffer.from('xx'))
  cache.set('z', Buffer.alloc(0))
  const [x, y, z] = unpack(cache.getPacked(['x', 'y', 'z']))
  assert.equal(x.toString(), 'xx')
  assert.equal(y, undefined)
  assert.equal(z.length, 0)
})

test('evicts to stay within maxBytes', () => {
  const cache = openCache('bounded', 64 * 1024)
  for (let i = 0; i < 1000; i++) cache.set(`k${i}`, Buffer.alloc(1024))
  assert.ok(cache.stats().bytes <= 64 * 1024)
})

test('worker threads share the same cache', async () => {
  openCache('shared', 1 << 20).set('from-main', Buffer.from('hi'))
  const code = `
    const { parentPort } = require('node:worker_threads')
    const cache = require(${JSON.stringify(require.resolve('..'))}).openCache('shared', 1 << 20)
    cache.set('from-worker', Buffer.from('yo'))
    parentPort.postMessage(cache.get('from-main').toString())
  `
  const seen = await new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true })
    w.once('message', resolve).once('error', reject)
  })
  assert.equal(seen, 'hi')
  assert.equal(openCache('shared', 1 << 20).get('from-worker').toString(), 'yo')
})
