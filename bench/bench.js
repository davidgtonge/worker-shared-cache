// Throughput benchmarks: single-thread ops against a JS Map baseline, then get() scaling across workers.
// Usage: node bench/bench.js [--value-bytes=1024] [--keys=10000] [--seconds=1] [--workers=1,4,24]
// --workers lists the worker counts to try; by default 1, 2, 4, 8 and the CPU count.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const os = require('node:os')
const { openCache } = require('..')

const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const arg = (name, def) => (flag(name) === undefined ? def : Number(flag(name)))
const VALUE_BYTES = arg('value-bytes', 1024)
const KEYS = arg('keys', 10_000)
const SECONDS = arg('seconds', 1)
const BATCH = 64
const MAX_BYTES = 512 * 1024 * 1024

const keys = Array.from({ length: KEYS }, (_, i) => `key:${i}`)
const absent = keys.map((k) => `absent:${k}`) // spread over the cache's shards like real misses
const value = Buffer.alloc(VALUE_BYTES, 7)

// Results land here so V8 can't drop calls whose value is unused.
let sink = 0
const use = (v) => { sink ^= v ? v.length | 1 : 0; return 1 }

// Runs fn in a loop for SECONDS (after a short warmup) and returns ops/sec. fn returns ops done per call.
function measure(fn) {
  const warmEnd = performance.now() + 100
  while (performance.now() < warmEnd) fn()
  let ops = 0
  const start = performance.now()
  const end = start + SECONDS * 1000
  let now = start
  while (now < end) {
    for (let i = 0; i < 100; i++) ops += fn()
    now = performance.now()
  }
  return ops / ((now - start) / 1000)
}

function fill(cache) {
  for (const k of keys) cache.setBuffer(k, value)
}

function singleThread() {
  const cache = openCache('bench-single', MAX_BYTES)
  fill(cache)
  const map = new Map(keys.map((k) => [k, Buffer.from(value)]))
  let i = 0
  const next = () => keys[i++ % KEYS]
  const nextAbsent = () => absent[i++ % KEYS]
  const batch = () => Array.from({ length: BATCH }, next)

  const rows = [
    ['Map.get (baseline)', measure(() => use(map.get(next())))],
    ['Map.get + copy', measure(() => use(Buffer.from(map.get(next()))))],
    ['cache.getBuffer (hit)', measure(() => use(cache.getBuffer(next())))],
    ['cache.getBuffer (miss)', measure(() => use(cache.getBuffer(nextAbsent())))],
    ['cache.setBuffer', measure(() => (cache.setBuffer(next(), value), 1))],
    [`cache.getPacked x${BATCH}`, measure(() => (use(cache.getPacked(batch())), BATCH))],
    [`cache.getBuffer x${BATCH} (loop)`, measure(() => { for (let j = 0; j < BATCH; j++) use(cache.getBuffer(next())); return BATCH })],
  ]
  return rows
}

function runWorkers(n, mode) {
  return Promise.all(
    Array.from({ length: n }, (_, id) => new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { id, mode, VALUE_BYTES, KEYS, SECONDS } })
      w.once('message', resolve).once('error', reject)
    })),
  ).then((rates) => rates.reduce((a, b) => a + b, 0))
}

async function main() {
  console.log(`node ${process.version}, ${os.availableParallelism()} CPUs (${os.cpus()[0].model}), ${os.platform()}/${os.arch()}`)
  console.log(`value ${VALUE_BYTES} B, ${KEYS} keys, ${SECONDS}s per case\n`)

  console.log('single thread')
  for (const [name, rate] of singleThread()) console.log(`  ${name.padEnd(26)} ${fmt(rate)}`)

  fill(openCache('bench-workers', MAX_BYTES))
  const counts = workerCounts()
  for (const mode of ['get', 'miss', 'mixed']) {
    const label = { get: '100% get (hits)', miss: '100% get (misses)', mixed: '90% get / 10% set' }[mode]
    console.log(`\nworkers, ${label} (total ops/s)`)
    let base
    for (const n of counts) {
      const rate = await runWorkers(n, mode)
      base ??= rate
      console.log(`  ${String(n).padStart(2)} worker${n === 1 ? ' ' : 's'}  ${fmt(rate)}  ${(rate / base).toFixed(2)}x`)
    }
  }
}

function workerCounts() {
  if (flag('workers')) {
    const counts = flag('workers').split(',').map(Number)
    if (counts.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('--workers takes counts like 1,4,24')
    return counts
  }
  const cpus = os.availableParallelism()
  return [...new Set([1, 2, 4, 8, cpus])].filter((n) => n <= cpus).sort((a, b) => a - b)
}

function fmt(rate) {
  return `${(rate / 1e6).toFixed(2).padStart(7)} M ops/s`
}

if (isMainThread) {
  main().catch((e) => { console.error(e); process.exit(1) })
} else {
  const cache = openCache('bench-workers', MAX_BYTES)
  let i = workerData.id * 7919
  const next = () => keys[i++ % KEYS]
  const nextAbsent = () => absent[i++ % KEYS]
  const run = {
    get: () => use(cache.getBuffer(next())),
    miss: () => use(cache.getBuffer(nextAbsent())),
    mixed: () => (i % 10 === 0 ? (cache.setBuffer(next(), value), 1) : use(cache.getBuffer(next()))),
  }[workerData.mode]
  const rate = measure(run)
  parentPort.postMessage(rate)
}
