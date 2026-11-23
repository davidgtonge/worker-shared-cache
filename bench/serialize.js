// JSON vs v8.serialize for a 10-key object (5 strings, 5 numbers), alone and round-tripped through the cache.
// Usage: node bench/serialize.js [--seconds=1]
const v8 = require('node:v8')
const { openCache } = require('..')

const SECONDS = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 1)
const N = 1000

// Distinct objects so neither encoder benefits from seeing the same input twice in a row.
const objects = Array.from({ length: N }, (_, i) => ({
  id: 100000 + i,
  name: `user-${i}`,
  email: `user${i}@example.com`,
  country: ['GB', 'US', 'DE', 'FR', 'JP'][i % 5],
  plan: i % 3 ? 'pro' : 'free',
  status: 'active',
  score: i * 1.37,
  logins: i % 500,
  balance: (i * 7919) % 100000 / 100,
  createdAt: 1700000000000 + i * 86400000,
}))
const keys = objects.map((_, i) => `obj:${i}`)

const codecs = {
  JSON: {
    encode: (o) => Buffer.from(JSON.stringify(o)),
    decode: (b) => JSON.parse(b),
  },
  v8: {
    encode: (o) => v8.serialize(o),
    decode: (b) => v8.deserialize(b),
  },
}

let sink = 0
function measure(fn) {
  let i = 0
  const warmEnd = performance.now() + 200
  while (performance.now() < warmEnd) sink ^= fn(i++ % N) ? 1 : 0
  let ops = 0
  const start = performance.now()
  let now = start
  while (now < start + SECONDS * 1000) {
    for (let j = 0; j < 100; j++) sink ^= fn(i++ % N) ? 1 : 0
    ops += 100
    now = performance.now()
  }
  return ops / ((now - start) / 1000)
}

const fmt = (r) => `${(r / 1e6).toFixed(2).padStart(6)} M/s  ${(1e9 / r).toFixed(0).padStart(5)} ns`

console.log(`node ${process.version}, ${process.platform}/${process.arch}, ${SECONDS}s per case`)
console.log(`sample: ${JSON.stringify(objects[1])}\n`)

for (const [name, { encode, decode }] of Object.entries(codecs)) {
  const encoded = objects.map(encode)
  const cache = openCache(`serialize-${name}`, 64 * 1024 * 1024)
  keys.forEach((k, i) => cache.set(k, encoded[i]))
  const avg = encoded.reduce((s, b) => s + b.length, 0) / N

  console.log(`${name} (${avg.toFixed(0)} bytes per object)`)
  const rows = [
    ['encode', (i) => encode(objects[i])],
    ['decode', (i) => decode(encoded[i])],
    ['encode + cache.set', (i) => (cache.set(keys[i], encode(objects[i])), 1)],
    ['cache.get + decode', (i) => decode(cache.get(keys[i]))],
  ]
  for (const [label, fn] of rows) console.log(`  ${label.padEnd(20)} ${fmt(measure(fn))}`)
  console.log()
}
if (sink === 42) console.log('')
