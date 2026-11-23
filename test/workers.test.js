const { test } = require('node:test')
const assert = require('node:assert/strict')
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
