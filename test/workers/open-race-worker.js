// Waits on a shared barrier so every worker calls openCache on a new name at the same moment, then reports
// whether it opened the cache, and writes its id there if it did.
const { parentPort, workerData } = require('node:worker_threads')
const { openCache } = require('../..')

const { id, name, maxBytes, barrier } = workerData
const gate = new Int32Array(barrier)
Atomics.add(gate, 0, 1)
Atomics.wait(gate, 1, 0)
try {
  openCache(name, maxBytes).set(`from-${id}`, id)
  parentPort.postMessage({ id, maxBytes, opened: true })
} catch (error) {
  parentPort.postMessage({ id, maxBytes, opened: false, message: error.message })
}
