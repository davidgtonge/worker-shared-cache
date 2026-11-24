// Many workers read and write one cache at once; every value read back must be intact.
// Defaults to 24 workers; override with STRESS_WORKERS and STRESS_OPS (operations per worker).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const { openCache } = require('..')

const WORKERS = Number(process.env.STRESS_WORKERS ?? 24)
const OPS = Number(process.env.STRESS_OPS ?? 20_000)
const KEYS = 5000
// Small enough that the workload forces eviction; shards keep maxEntryBytes near 250 KB.
const CACHE = ['stress', 4 << 20, { shards: 16 }]

if (isMainThread) {
  test(`${WORKERS} workers share a cache without corrupting it`, async () => {
    const cache = openCache(...CACHE)
    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_, id) => runWorker(id)),
    )
    const total = (field) => results.reduce((sum, r) => sum + r[field], 0)

    assert.equal(total('corrupt'), 0, 'every value read matches its key and is intact')
    assert.equal(total('oversizedRejected'), total('oversizedAttempts'), 'every oversized write throws')
    assert.ok(total('hits') > 0 && total('misses') > 0, 'the workload both hits and misses')

    const stats = cache.stats()
    assert.equal(stats.hits, total('hits'))
    assert.equal(stats.misses, total('misses'))
    assert.ok(stats.bytes <= CACHE[1], `holds ${stats.bytes} bytes, within maxBytes`)
  })
} else {
  parentPort.postMessage(work(workerData.id))
}

function runWorker(id) {
  return new Promise((resolve, reject) => {
    new Worker(__filename, { workerData: { id } })
      .once('message', resolve)
      .once('error', reject)
      .once('exit', (code) => code !== 0 && reject(new Error(`worker ${id} exited with ${code}`)))
  })
}

// JSON values live under `j<k>` and raw ones under `r<k>`, so each read knows which format to check.
// A JSON value records its own key and a body of known length; a raw value is a header of key and body
// length, then the body filled with the key's low byte.
function work(id) {
  const cache = openCache(...CACHE)
  const rand = xorshift((id + 1) * 0x9e3779b9)
  const counts = { hits: 0, misses: 0, corrupt: 0, oversizedAttempts: 0, oversizedRejected: 0 }
  const seen = (value, intact) => {
    if (value === undefined) return counts.misses++
    counts.hits++
    if (!intact(value)) counts.corrupt++
  }
  const jsonIntact = (k) => (v) => v.k === k && v.body === 'x'.repeat(v.n)
  const rawIntact = (k) => (b) =>
    b.readUInt32LE(0) === k && b.length === 8 + b.readUInt32LE(4) && b.subarray(8).every((x) => x === (k & 0xff))

  for (let i = 0; i < OPS; i++) {
    const k = rand(KEYS)
    const op = rand(100)
    if (op < 40) {
      seen(cache.get(`j${k}`), jsonIntact(k))
    } else if (op < 55) {
      seen(cache.getBuffer(`r${k}`), rawIntact(k))
    } else if (op < 70) {
      seen(cache.getBuffer(`j${k}`), (b) => jsonIntact(k)(JSON.parse(b)))
    } else if (op < 85) {
      const n = rand(2000)
      cache.set(`j${k}`, { k, writer: id, n, body: 'x'.repeat(n) })
    } else if (op < 99) {
      const n = rand(4000)
      const b = Buffer.alloc(8 + n, k & 0xff)
      b.writeUInt32LE(k, 0)
      b.writeUInt32LE(n, 4)
      cache.setBuffer(`r${k}`, b)
    } else {
      counts.oversizedAttempts++
      try {
        cache.setBuffer(`r${k}`, Buffer.alloc(cache.maxEntryBytes))
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
        counts.oversizedRejected++
      }
    }
  }
  return counts
}

function xorshift(seed) {
  let state = seed | 0 || 1
  return (n) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % n
  }
}
