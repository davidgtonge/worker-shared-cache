// Opens the shared cache and mixes reads and writes, checking every value it reads belongs to its key.
// Runs workerData.operations calls (Infinity: until terminated), telling the parent once it has started.
const { parentPort, workerData } = require('node:worker_threads')
const { openCache } = require('../..')

const { id, name, maxBytes, keyCount, operations } = workerData
const cache = openCache(name, maxBytes)
parentPort.postMessage({ started: true })

let completed = 0
while (completed < operations) {
  const key = `k${(id * 7919 + completed) % keyCount}`
  if (completed % 4 === 0) {
    cache.set(key, { key, writer: id })
  } else {
    const value = cache.get(key)
    if (value !== undefined && value.key !== key) throw new Error(`read ${JSON.stringify(value)} for ${key}`)
  }
  completed++
}
parentPort.postMessage({ completed })
