// Writes its own key, then on the parent's signal reads every worker's key and reports what it saw and the
// cache's stats. Worker 0 also writes a large block of data first. The parent never touches the cache.
const { parentPort, workerData } = require('node:worker_threads')
const { openCache } = require('../..')

const { id, workerCount, name, bigBlockBytes } = workerData
const cache = openCache(name, 256 << 20, { shards: 8 })
if (id === 0) {
  const block = Buffer.alloc(64 << 10, 7)
  for (let index = 0; index < bigBlockBytes / block.length; index++) cache.setBuffer(`block-${index}`, block)
}
cache.set(`from-${id}`, { writer: id })
parentPort.postMessage({ wrote: true })

parentPort.once('message', () => {
  const seen = []
  for (let other = 0; other < workerCount; other++) seen.push(cache.get(`from-${other}`)?.writer)
  parentPort.postMessage({ id, seen, stats: cache.stats(), firstBlock: cache.getBuffer('block-0')?.[0] })
})
