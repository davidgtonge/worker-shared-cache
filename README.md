# worker-shared-cache

A byte-bounded in-memory cache, shared by every Node.js worker thread in the process.

Each named cache lives in native memory (Rust, [`quick_cache`](https://crates.io/crates/quick_cache)), so
`worker_threads` that open the same name see the same entries without copying data through `postMessage`.
Entries are weighed by `key.length + value.length` bytes and evicted once the cache exceeds `maxBytes`.

## Install

```sh
npm install worker-shared-cache
```

Prebuilt binaries ship for these platforms, and npm installs only the one matching the machine. Node 22 or later.

| Platform | Package |
|---|---|
| macOS arm64 / x64 | `worker-shared-cache-darwin-arm64`, `-darwin-x64` |
| Linux x64 / arm64 (glibc 2.31+: Debian 11+, Ubuntu 20.04+, Amazon Linux 2023, RHEL 9) | `-linux-x64-gnu`, `-linux-arm64-gnu` |
| Alpine and other musl Linux, x64 / arm64 (including AWS Graviton) | `-linux-x64-musl`, `-linux-arm64-musl` |
| Windows x64 | `-win32-x64-msvc` |

## Usage

```js
const { openCache } = require('worker-shared-cache')

const cache = openCache('users', 256 * 1024 * 1024) // 256 MB

cache.set('user:1', { id: 1, name: 'Ada' }) // stored as JSON
cache.get('user:1')  // { id: 1, name: 'Ada' }, a fresh copy
cache.get('missing') // undefined

cache.setBuffer('thumb:1', pngBytes) // raw bytes: a Buffer, typed array or DataView
cache.getBuffer('thumb:1')           // <Buffer 89 50 4e 47 ...>

cache.stats() // { entries, bytes, hits, misses }
```

Calling `openCache` with the same name from any thread returns the same cache. Reopening it with a
different `maxBytes` or options throws. Keys must be strings; wrong-typed arguments and unknown options
throw a `TypeError`.

### Options

```js
openCache('images', 512 * 1024 * 1024, {
  shards: 8,                 // 1 to 65536; default: CPU count × 4, rounded up to a power of two (see Shards)
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
npm run build     # release build of the native addon for this platform, then tsc
npm test
npm run lint      # rustfmt, clippy (pedantic, warnings as errors) and a strict tsc type check
npm run coverage  # JS coverage (fails below 100%) and Rust coverage of an instrumented build
```

`npm run coverage` needs `cargo install cargo-llvm-cov` and `rustup component add llvm-tools`. JS is at 100%,
as is every Rust file but `bindings.rs`, whose only uncovered lines are the code `#[napi]` generates to
reject wrong-typed arguments; `src/index.ts` rejects those first with a `TypeError`.

`test/stress.test.js` runs 24 workers against one small cache at once, mixing JSON and raw reads and writes
with oversized writes, and checks every value read back is intact and the stats add up. Scale it with
`STRESS_WORKERS=48 STRESS_OPS=100000 node --test test/stress.test.js`.

| Path | What it holds |
|---|---|
| `src/index.ts` | The public API: JSON and raw views over the native cache, plus argument checks |
| `lib/` | Build output: `index.js` and `index.d.ts` from `tsc`, the built `.node` file, and the loader napi-rs generates (`binding.js`, `binding.d.ts`, committed so TypeScript can compile without a Rust build) |
| `npm/` | One package per platform, each publishing that platform's `.node` file |
| `.github/workflows/ci.yml` | Native builds and tests per platform, lint, coverage, and publishing on version tags |
| `native/` | The Rust crate (`cargo` commands take `--manifest-path native/Cargo.toml`) |
| `native/src/bindings.rs` | The napi surface `src/index.ts` calls |
| `native/src/config.rs` | Option validation and defaults |
| `native/src/store.rs` | One cache: lookups, the per-entry size limit, stats |
| `native/src/counters.rs` | Hit and miss counts that threads bump without contending |
| `native/src/registry.rs` | The process-wide map from cache name to store |
| `test/`, `bench/` | `node:test` suites and throughput benchmarks |

## CI and releases

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds every platform on its own architecture and
runs the full test suite there: Linux glibc builds in Debian bullseye containers (so the binaries need glibc
2.31, not the runner's newer one) and musl builds in Alpine containers, each on x64 and arm64 runners.

To release, with an `NPM_TOKEN` repository secret that can publish:

```sh
npm version minor   # bumps package.json and every npm/<platform>/package.json, commits, tags
git push --follow-tags
```

The tag starts the `publish` job once lint, coverage and every build pass. It moves each binary into its
`npm/<platform>` package, publishes those, then publishes `worker-shared-cache` pinned to them.

## License

MIT
