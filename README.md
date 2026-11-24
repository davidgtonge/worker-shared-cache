# node-shared-cache

A byte-bounded in-memory cache, shared by every Node.js worker thread in the process.

Each named cache lives in native memory (Rust, [`quick_cache`](https://crates.io/crates/quick_cache)), so
`worker_threads` that open the same name see the same entries without copying data through `postMessage`.
Entries are weighed by `key.length + value.length` bytes and evicted once the cache exceeds `maxBytes`.

## Usage

```js
const { openCache } = require('node-shared-cache')

const cache = openCache('users', 256 * 1024 * 1024) // 256 MB

cache.set('user:1', { id: 1, name: 'Ada' }) // stored as JSON
cache.get('user:1')  // { id: 1, name: 'Ada' }, a fresh copy
cache.get('missing') // undefined

cache.setBuffer('thumb:1', pngBytes) // raw bytes: a Buffer, typed array or DataView
cache.getBuffer('thumb:1')           // <Buffer 89 50 4e 47 ...>

cache.stats() // { entries, bytes, hits, misses }
```

Calling `openCache` with the same name from any thread returns the same cache. Reopening it with a
different `maxBytes` or options throws.

### Options

```js
openCache('images', 512 * 1024 * 1024, {
  shards: 8,                 // default: CPU count × 4, rounded up to a power of two (see Shards)
  hotAllocation: 0.97,       // default: 0.97
  estimatedEntryBytes: 64e3, // default: 1024; only sizes internal tables
})
```

### Eviction

Eviction follows [S3-FIFO](https://s3fifo.com), via [`quick_cache`](https://crates.io/crates/quick_cache),
rather than LRU. A new key first sits in a small probation area and is evicted early unless it is read
again; keys that are read again move to the main area (`hotAllocation` of the space). The cache also
remembers recently evicted keys and readmits them straight to the main area. Hit rates are as good as LRU's
or better, and a one-off scan over many keys can't flush out the entries you use often.

### Shards

A cache is not one table but several independent ones, called shards. Each key belongs to exactly one
shard, picked by hashing the key, so keys spread evenly across them. Each shard has:

- **its own lock.** Reads share a shard; a write has it to itself for the moment it takes. Threads
  touching different shards never wait for each other, so more shards means less waiting when many
  workers write at once.
- **its own share of memory**: `maxBytes / shards`. A shard evicts when *it* is full, even if others have
  room. With keys spread evenly this evens out, so the cache as a whole stays close to `maxBytes`.
- **its own eviction**, as described above, over just its keys.

The number of shards is fixed when the cache opens. By default it is 4 per CPU core, rounded up to a power
of two: 64 on a 10- or 16-core machine. `shards` overrides it (also rounded up to a power of two), and a cache
too small to give every shard about 32 entries (judged by `estimatedEntryBytes`) gets fewer.
`cache.shards` reports the number in use.

**The catch: one entry must fit in one shard.** An entry (key + value) can be at most about
`maxBytes / shards`; `cache.maxEntryBytes` gives the exact figure (a shard's `hotAllocation`). `set` and
`setBuffer` throw a `RangeError` for anything bigger, and drop any older value under that key.

| `maxBytes` | `shards` | `maxEntryBytes` (about) |
|---|---|---|
| 64 MB | 64 (default, 10–16 cores) | 1 MB |
| 64 MB | 8 | 8 MB |
| 512 MB | 64 | 8 MB |
| 512 MB | 16 | 32 MB |

**Choosing a number:**

- Small values (up to a few KB), many workers: keep the default.
- Large values: pick `shards` so that `maxBytes / shards` is at least 2–4× your largest value, which also
  stops a few big entries crowding everything else out of their shard.
- Few workers, or mostly reads: fewer shards cost little, since reads share a shard's lock anyway.

### JSON or raw bytes

- `get` / `set` run values through `JSON.stringify` / `JSON.parse`. `get` has the native side make the JS
  string `JSON.parse` needs straight from the cached bytes, skipping the Buffer that dominates a raw read,
  so it costs little more than `JSON.parse` itself. `set` throws for values with no JSON form
  (`undefined`, functions, `BigInt`), and `get` returns `undefined` on a miss, so a stored `null` stays `null`.
- `getBuffer` / `setBuffer` store bytes untouched. Use them for binary data or your own encoding, such as
  `v8.serialize` when values hold `Date`, `Map`, `Set` or `BigInt`.

Both views share one store: `getBuffer` on a key written by `set` returns its UTF-8 JSON, and `get` on a key
written by `setBuffer` parses the bytes as JSON.

### Batch reads

`getPacked(keys)` looks up many keys' raw bytes in one native call and returns a single `Buffer`: for each key, a
`u32` little-endian length followed by that many bytes, or `0xffffffff` with no bytes for a miss.

One call and one Buffer for the whole batch makes this about 5x faster than looping `getBuffer` for 64-byte
values and 2.5x for 1 KB values. From about 16 KB up both are bound by copying the bytes and run level.

```js
function unpack(buf) {
  const out = []
  for (let at = 0; at < buf.length; ) {
    const len = buf.readUInt32LE(at)
    at += 4
    if (len === 0xffffffff) { out.push(undefined); continue }
    out.push(buf.subarray(at, at + len))
    at += len
  }
  return out
}
```

## Notes

- Values are copied in on `set` and out on `get`; the cache never hands JS a view of its own memory.
- On Linux the addon uses mimalloc, since musl's allocator slows badly when many threads allocate at once.

## Benchmarks

```sh
npm run bench                              # 1 KB values, 10k keys, 1s per case
node bench/bench.js --value-bytes=64 --keys=100000 --seconds=2
node bench/bench.js --workers=1,4,16,24         # pick the worker counts (default: 1, 2, 4, 8, CPU count)
npm run bench:serialize                    # JSON vs v8.serialize for a 10-key object
```

This prints single-thread throughput next to a plain `Map` baseline, then the combined throughput of 1..N
worker threads for get hits, get misses, and a 90/10 get/set mix.

## Development

```sh
npm install
npm run build   # release build of the native addon for this platform
npm test
npm run lint    # rustfmt, clippy (pedantic, warnings as errors) and a type check of lib/index.d.ts
```

`test/stress.test.js` runs 24 workers against one small cache at once, mixing JSON and raw reads and writes
with oversized writes, and checks every value read back is intact and the stats add up. Scale it with
`STRESS_WORKERS=48 STRESS_OPS=100000 node --test test/stress.test.js`.

| Path | What it holds |
|---|---|
| `lib/index.js`, `lib/index.d.ts` | The public API: JSON and raw views over the native cache, plus argument checks |
| `lib/binding.js`, `lib/binding.d.ts` | The loader napi-rs generates for the native addon (`npm run build` rewrites them, and puts the built `.node` file beside them) |
| `native/` | The Rust crate (`cargo` commands take `--manifest-path native/Cargo.toml`) |
| `native/src/bindings.rs` | The napi surface `lib/index.js` calls |
| `native/src/config.rs` | Option validation and defaults |
| `native/src/store.rs` | One cache: lookups, the per-entry size limit, stats |
| `native/src/counters.rs` | Hit and miss counts that threads bump without contending |
| `native/src/registry.rs` | The process-wide map from cache name to store |
| `test/`, `bench/` | `node:test` suites and throughput benchmarks |

## License

MIT
