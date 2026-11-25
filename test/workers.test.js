const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { openCache } = require('..')

test('worker threads share the same cache', async () => {
  openCache('shared', 1 << 20).set('from-main', { hi: 'there' })
  const code = `
    const { parentPort } = require('node:worker_threads')
    const cache = require(${JSON.stringify(require.resolve('..'))}).openCache('shared', 1 << 20)
    cache.set('from-worker', [1, 2, 3])
    parentPort.postMessage(cache.get('from-main'))
  `
  const seen = await new Promise((resolve, reject) => {
    new Worker(code, { eval: true }).once('message', resolve).once('error', reject)
  })
  assert.deepEqual(seen, { hi: 'there' })
  assert.deepEqual(openCache('shared', 1 << 20).get('from-worker'), [1, 2, 3])
})

test('workers share one store: each sees the others\' writes, the same stats, and one copy of the data', async () => {
  // The main thread never opens this cache, so the only way workers can see each other's values is through
  // the shared store. A per-worker cache would leave each worker seeing only its own key, its own stats,
  // and would hold a copy of the 64 MB block per worker.
  const workerCount = 8
  const bigBlockBytes = 64 << 20
  const rssBefore = process.memoryUsage().rss
  const workers = Array.from({ length: workerCount }, (_, id) =>
    new Worker(path.join(__dirname, 'workers', 'share-worker.js'), {
      workerData: { id, workerCount, name: 'shared-proof', bigBlockBytes },
    }))
  const next = (worker) => new Promise((resolve, reject) => worker.once('message', resolve).once('error', reject))
  await Promise.all(workers.map(next)) // every worker has written
  const reports = await Promise.all(workers.map((worker) => {
    const report = next(worker)
    worker.postMessage('read')
    return report
  }))
  const rssGrowth = process.memoryUsage().rss - rssBefore
  await Promise.all(workers.map((worker) => worker.terminate()))

  const everyWriter = Array.from({ length: workerCount }, (_, id) => id)
  for (const report of reports) {
    assert.deepEqual(report.seen, everyWriter, `worker ${report.id} sees every worker's write`)
    assert.equal(report.firstBlock, 7, `worker ${report.id} reads worker 0's block`)
  }
  // Stats are read at slightly different moments, so hits differ, but entries and bytes are one store's.
  const [first] = reports
  for (const report of reports) {
    assert.equal(report.stats.entries, first.stats.entries)
    assert.equal(report.stats.bytes, first.stats.bytes)
  }
  assert.equal(first.stats.entries, bigBlockBytes / (64 << 10) + workerCount)
  // Every worker's reads land in the one store's counters: at least all 8 x 8 key reads, plus the blocks.
  const mostHits = Math.max(...reports.map((report) => report.stats.hits))
  assert.ok(mostHits >= workerCount * workerCount, `${mostHits} hits counted from all workers`)
  // One copy of the block, not one per worker: 8 copies would add 512 MB.
  assert.ok(rssGrowth < bigBlockBytes * 3, `memory grew ${Math.round(rssGrowth / 2 ** 20)} MB`)
})
