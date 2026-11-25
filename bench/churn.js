// Memory under worker churn: starts many short-lived workers, at most 24 alive at once, each opening the
// shared cache and making cache calls (a third are terminated mid-loop). Run it again with `--baseline`,
// which does the same with a plain Map and no addon: if memory grows about the same, the growth is Node's
// own per-worker cost, not the addon leaking.
// Usage: node --expose-gc bench/churn.js [--workers=2400] [--baseline]
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')

const flag = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split('=')[1]
const baseline = process.argv.includes('--baseline')
const totalWorkers = Number(flag('workers') ?? 2400)
const maxLive = 24
const megabytes = () => Math.round(process.memoryUsage().rss / 2 ** 20)

if (!isMainThread) {
  const store = workerData.baseline ? new Map() : require('..').openCache('churn', 4 << 20)
  for (let operation = 0; operation < workerData.operations; operation++) {
    const key = `k${(workerData.id * 7919 + operation) % 5000}`
    if (operation % 4 === 0) store.set(key, { key })
    else if (store.get(key)?.key !== undefined && store.get(key).key !== key) throw new Error(`corrupt ${key}`)
  }
  parentPort.postMessage('done')
} else {
  main()
}

async function main() {
  const samples = [megabytes()]
  let started = 0
  let finished = 0
  let failed = 0
  await new Promise((resolve) => {
    const launchMore = () => {
      while (started - finished < maxLive && started < totalWorkers) {
        const id = started++
        const terminateEarly = id % 3 === 0
        const worker = new Worker(__filename, { workerData: { id, baseline, operations: terminateEarly ? Infinity : 2000 } })
        if (terminateEarly) setTimeout(() => worker.terminate(), Math.random() * 5)
        worker.once('error', () => failed++)
        worker.once('exit', () => {
          finished++
          if (finished % Math.ceil(totalWorkers / 5) === 0) samples.push(megabytes())
          if (finished === totalWorkers) resolve()
          else launchMore()
        })
      }
    }
    launchMore()
  })
  global.gc?.()
  samples.push(megabytes())
  console.log(`${baseline ? 'baseline (Map, no addon)' : 'addon'}: ${totalWorkers} workers, at most ${maxLive} alive, ${failed} failed`)
  console.log(`  rss MB at each fifth of the run: ${samples.join(' -> ')}  (grew ${samples.at(-1) - samples[0]} MB)`)
}
