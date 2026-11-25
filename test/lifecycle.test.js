// Worker lifecycles: thousands of short-lived workers with at most 24 alive at once, some terminated in the
// middle of cache calls; workers racing to open a new cache; and a Piscina pool whose idle workers exit and
// are replaced. Raise the worker count with LIFECYCLE_WORKERS (default 1000).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { Piscina } = require('piscina')
const { openCache } = require('..')

const MAX_LIVE_WORKERS = 24
const TOTAL_WORKERS = Number(process.env.LIFECYCLE_WORKERS ?? 1000)
const workerPath = (file) => path.join(__dirname, 'workers', file)

// Starts workers one after another, keeping at most `maxLive` running, until `total` have run and exited.
// Returns each worker's outcome and the largest number that were ever alive together.
async function runWithAtMost(maxLive, total, startWorker) {
  const outcomes = []
  let started = 0
  let live = 0
  let peakLive = 0
  await new Promise((resolve, reject) => {
    const launchMore = () => {
      while (live < maxLive && started < total) {
        live++
        peakLive = Math.max(peakLive, live)
        startWorker(started++).then((outcome) => {
          outcomes.push(outcome)
          live--
          if (outcomes.length === total) resolve()
          else launchMore()
        }, reject)
      }
    }
    launchMore()
  })
  return { outcomes, peakLive }
}

test(`${TOTAL_WORKERS} short-lived workers, at most ${MAX_LIVE_WORKERS} alive, share one cache intact`, async () => {
  const name = 'lifecycle-churn'
  const maxBytes = 2 << 20
  const keyCount = 4000
  const cache = openCache(name, maxBytes)

  // A third of the workers are terminated a few milliseconds after starting, mid-loop; the rest finish.
  const { outcomes, peakLive } = await runWithAtMost(MAX_LIVE_WORKERS, TOTAL_WORKERS, (id) => {
    const terminateEarly = id % 3 === 0
    return new Promise((resolve) => {
      const worker = new Worker(workerPath('churn-worker.js'), {
        workerData: { id, name, maxBytes, keyCount, operations: terminateEarly ? Infinity : 500 },
      })
      let outcome = 'exited without finishing'
      worker.on('message', (message) => {
        if (message.completed) outcome = 'completed'
        if (message.started && terminateEarly) {
          setTimeout(() => worker.terminate(), Math.random() * 3)
          outcome = 'terminated'
        }
      })
      worker.once('error', (error) => { outcome = `error: ${error.message}` })
      worker.once('exit', () => resolve(outcome))
    })
  })

  const tally = Object.groupBy(outcomes, (outcome) => outcome)
  assert.deepEqual(Object.keys(tally).sort(), ['completed', 'terminated'], JSON.stringify(Object.keys(tally)))
  assert.equal(tally.completed.length + tally.terminated.length, TOTAL_WORKERS)
  assert.equal(peakLive, Math.min(MAX_LIVE_WORKERS, TOTAL_WORKERS))

  for (let index = 0; index < keyCount; index++) {
    const value = cache.get(`k${index}`)
    if (value !== undefined) assert.equal(value.key, `k${index}`)
  }
  assert.ok(cache.stats().bytes <= maxBytes)
})

// Each round, MAX_LIVE_WORKERS new workers load the addon and call openCache on a fresh name at the same
// instant. With conflicting options exactly one configuration must win, and all its openers share a store.
for (const conflicting of [false, true]) {
  test(`${MAX_LIVE_WORKERS} workers racing to open a new cache${conflicting ? ' with conflicting options' : ''}`, async () => {
    for (let round = 0; round < 5; round++) {
      const name = `race-${conflicting}-${round}`
      const barrier = new SharedArrayBuffer(8)
      const gate = new Int32Array(barrier)
      const workers = []
      const reports = Array.from({ length: MAX_LIVE_WORKERS }, (_, id) => new Promise((resolve, reject) => {
        const maxBytes = conflicting && id % 2 ? 2 << 20 : 1 << 20
        const worker = new Worker(workerPath('open-race-worker.js'), { workerData: { id, name, maxBytes, barrier } })
        workers.push(worker)
        worker.once('message', resolve).once('error', reject)
      }))
      while (Atomics.load(gate, 0) < MAX_LIVE_WORKERS) await new Promise((resolve) => setTimeout(resolve, 1))
      Atomics.store(gate, 1, 1)
      Atomics.notify(gate, 1)
      const results = await Promise.all(reports)
      await Promise.all(workers.map((worker) => worker.terminate()))

      const openers = results.filter((result) => result.opened)
      const winningSizes = new Set(openers.map((result) => result.maxBytes))
      assert.equal(winningSizes.size, 1, `round ${round}: one configuration wins`)
      const [winningSize] = winningSizes
      for (const loser of results.filter((result) => !result.opened)) {
        assert.notEqual(loser.maxBytes, winningSize, `round ${round}: only conflicting openers fail`)
        assert.match(loser.message, /already open with maxBytes/)
      }
      if (!conflicting) assert.equal(openers.length, MAX_LIVE_WORKERS)
      const shared = openCache(name, winningSize)
      for (const opener of openers) assert.equal(shared.get(`from-${opener.id}`), opener.id, `round ${round}`)
    }
  })
}

test(`a Piscina pool of ${MAX_LIVE_WORKERS} threads whose idle workers exit keeps the cache intact`, async () => {
  const cache = openCache('piscina', 8 << 20)
  const pool = new Piscina({ filename: workerPath('piscina-task.js'), minThreads: 0, maxThreads: MAX_LIVE_WORKERS, idleTimeout: 10 })
  const threadIds = new Set()
  let reads = 0
  let peakThreads = 0
  const rounds = 10
  for (let round = 0; round < rounds; round++) {
    const tasks = Array.from({ length: 1000 }, (_, index) => {
      const key = `k${(round * 37 + index) % 2000}`
      return index % 3 === 0 ? pool.run({ operation: 'set', key, size: index % 300 }) : pool.run({ operation: 'get', key })
    })
    peakThreads = Math.max(peakThreads, pool.threads.length)
    for (const result of await Promise.all(tasks)) {
      threadIds.add(result.threadId)
      if ('hit' in result) reads++
      assert.ok(result.intact)
    }
    // Wait for the idle timeout to retire the workers, so the next round starts on new ones. (Piscina may
    // keep one idle thread even with minThreads: 0.)
    const deadline = Date.now() + 2000
    while (pool.threads.length > 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(pool.threads.length <= 1, `round ${round}: idle workers exited`)
  }
  await pool.destroy()

  assert.ok(peakThreads <= MAX_LIVE_WORKERS)
  // Each round can start up to 24 new workers; most rounds must have started more than one.
  assert.ok(threadIds.size > rounds * 5, `workers were replaced across rounds (${threadIds.size} distinct)`)
  const stats = cache.stats()
  assert.equal(stats.hits + stats.misses, reads, 'every read the workers made is counted')

  // A pool created after the first is destroyed still sees the data.
  const second = new Piscina({ filename: workerPath('piscina-task.js'), maxThreads: 2 })
  const anyKey = [...Array(2000).keys()].map((index) => `k${index}`).find((key) => cache.get(key) !== undefined)
  assert.ok(anyKey)
  assert.equal((await second.run({ operation: 'get', key: anyKey })).hit, true)
  await second.destroy()
})
