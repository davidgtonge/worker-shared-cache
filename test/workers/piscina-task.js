// A Piscina task file. Piscina loads it once per worker, so every new worker opens the shared cache.
const { threadId } = require('node:worker_threads')
const { openCache } = require('../..')

const cache = openCache('piscina', 8 << 20)

module.exports = ({ operation, key, size }) => {
  if (operation === 'set') {
    cache.set(key, { key, body: 'x'.repeat(size) })
    return { threadId, intact: true }
  }
  const value = cache.get(key)
  const intact = value === undefined || (value.key === key && /^x*$/.test(value.body))
  return { threadId, intact, hit: value !== undefined }
}
