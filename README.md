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

TypeScript types are included: `SharedCache`, `CacheOptions` and `Stats`, with `get<T>()` for typed reads.
They work from CommonJS and ESM, under every TypeScript module setting, with TypeScript 5 and 7.

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

Calling `openCache` with the same name from any thread returns the same cache. Open it by name in each
thread that uses it: a cache object can't be sent to another thread (`postMessage` throws). Caches are
per process, so `cluster` workers and child processes each have their own.

Reopening a name with a different `maxBytes` or options that change the outcome throws (`shards: 30` and
`shards: 32` both give 32 shards, so they match). If threads open a new name at the same moment with
conflicting options, whichever gets there first wins, so give every opener the same options.

Keys must be strings with no lone surrogates (unpaired halves of an emoji, say): those can't be stored
exactly, so they'd collide with other keys, and are rejected instead. Arguments of the wrong type and
unknown options throw a `TypeError`; out-of-range options throw a `RangeError`.

`maxBytes` approximates memory: each entry counts its key and value bytes plus 192 bytes for the cache's
own bookkeeping. Measured use is about 1.1–1.4× `maxBytes` once full, the rest being allocator rounding.

### Options

```js
openCache('images', 512 * 1024 * 1024, {
  shards: 8,                 // 1 to 65536, rounded up to a power of two; default: 64 (see Shards)
  hotAllocation: 0.97,       // default: 0.97
  estimatedEntryBytes: 64e3, // typical key + value bytes; default: 1024 (see Shards)
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

The number of shards is fixed when the cache opens: 64 by default, the same on every machine, so a cache
accepts the same entries in development and production. `shards` overrides it (rounded up to a power of
two). A cache too small to give every shard room for about 32 entries of `estimatedEntryBytes` gets fewer
shards, which also raises `maxEntryBytes`. `cache.shards` reports the number in use.

**The catch: one entry must fit in one shard.** An entry (key + value) can be at most about
`maxBytes / shards`; `cache.maxEntryBytes` gives the exact figure (a shard's `hotAllocation`, less the
192-byte bookkeeping allowance). `set` and `setBuffer` throw a `RangeError` for anything bigger, and drop
any older value under that key. A `maxBytes` too small for any entry is a `RangeError` when opening.

| `maxBytes` | `shards` | `maxEntryBytes` (about) |
|---|---|---|
| 64 MB | 64 (default) | 1 MB |
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
- `getBuffer` / `setBuffer` store bytes untouched: exactly the bytes a Buffer, typed array or DataView
  views. A view of a transferred (detached) ArrayBuffer is rejected. Use them for binary data or your own
  encoding, such as `v8.serialize` when values hold `Date`, `Map`, `Set` or `BigInt`.

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
npm run bench:churn                        # memory over 2,400 short-lived workers (add -- --baseline)
```

This prints single-thread throughput next to a plain `Map` baseline, then the combined throughput of 1..N
worker threads for get hits, get misses, and a 90/10 get/set mix.

## Security

### Reporting a vulnerability

Please report security problems privately, not in a public issue: use **Report a vulnerability** on the
[Security tab](https://github.com/davidgtonge/worker-shared-cache/security/advisories/new). Include the
version, platform and, if you can, a way to reproduce it. Fixes ship as a new release; only the latest
version is supported.

### JS dependencies

- **None at runtime.** Installing pulls in only `worker-shared-cache` and the one prebuilt package for the
  machine (an `optionalDependency` pinned to the exact same version). Nothing runs or compiles on install:
  no package has install scripts.
- The development tools (`@napi-rs/cli`, `typescript`, `@types/node`, `@arethetypeswrong/cli`) are dev
  dependencies only, locked in `package-lock.json` and installed with `npm ci`.
- Dependabot proposes updates weekly.

### Rust dependencies

- Compiled into the binary: `napi` and `napi-derive` (Node-API bindings), `quick_cache` (the cache itself),
  and on Linux `mimalloc` (the allocator). `napi-build` runs only at build time. All 49 crates are locked in
  `native/Cargo.lock`.
- The crate has no `unsafe` code of its own, and clippy runs in pedantic mode with warnings as errors.
- Dependabot proposes updates weekly.

### Publishing

Releases publish from CI with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers). (0.1.0,
the first release, was the exception: npm can only trust a package that already exists, so the maintainer
published it with 2FA, from binaries CI had built and tested.)

- **No npm tokens.** For each release GitHub gives the publish job a short-lived OIDC token, which npm accepts
  only for these packages, from `ci.yml` in this repository, in the `npm` environment. Every package is set
  to require two-factor authentication and disallow tokens, so nothing else can publish.
- **A person approves each release.** The `npm` environment needs a maintainer's approval and accepts only
  `v*` tags, and a ruleset lets only repository admins create, move or delete those tags.
- **Only tested binaries ship.** A release publishes the binaries built and tested on their own platforms in
  the same run, after lint, coverage and the type checks pass, and only if the tag matches `package.json`.
- **Pinned inputs.** Actions are pinned to commit SHAs and build images to digests. Release builds restore
  no caches, and the publish job installs with `--ignore-scripts`.
- **Verifiable.** From 0.1.1, each package carries [provenance](https://docs.npmjs.com/generating-provenance-statements):
  a signed record of the commit and workflow that built it. `npm audit signatures` checks it.

## Contributing

Issues and pull requests are welcome. For anything bigger than a fix, open an issue first so we can agree
on the approach. Security problems go through [private reporting](#reporting-a-vulnerability) instead.

### Setup

You need Node 22+ and stable Rust ([rustup](https://rustup.rs)). For `npm run coverage`, also
`cargo install cargo-llvm-cov` and `rustup component add llvm-tools`.

```sh
npm install
npm run build             # native addon for this platform (release build), then tsc
npm test
npm run lint              # rustfmt, clippy (pedantic, warnings as errors) and a strict tsc type check
npm run check:types       # pack, then check the types with Are the Types Wrong and a TypeScript 5 consumer
npm run check:types -- 7  # the same with TypeScript 7
npm run coverage          # JS coverage (fails below 100%) and Rust coverage of an instrumented build
```

### Before opening a pull request

- Add or update tests for any change in behaviour, and keep JS coverage at 100%. (The only Rust lines left
  uncovered are the code `#[napi]` generates to reject wrong-typed arguments, which `src/index.ts` rejects
  first.)
- Make sure `npm test`, `npm run lint` and `npm run check:types` pass.
- CI then builds and tests every platform on its own architecture: macOS arm64 and x64, Windows x64, and Linux
  x64 and arm64 for both glibc (in Debian bullseye, so the binaries need only glibc 2.31) and musl (in Alpine).
  It also assembles and dry-runs the release.

The tests include the cases that matter most for a cache shared across threads:

- `test/workers.test.js`: workers see each other's writes with the main thread never touching the cache,
  report the same entries and bytes, and hold one copy of the data (64 MB written once, not per worker).
- `test/lifecycle.test.js`: 1,000 short-lived workers with at most 24 alive, a third terminated mid-loop;
  24 workers racing to open a new cache, with the same and with conflicting options; and 24-thread Piscina
  pools started and destroyed in turn, with idle workers exiting mid-round. `LIFECYCLE_WORKERS=5000 npm test`
  runs more.
- `test/stress.test.js`: 24 workers mixing JSON and raw reads and writes, and oversized writes, on one
  small cache, checking every value read back. `STRESS_WORKERS=48 STRESS_OPS=100000` scales it.

`npm run bench:churn` (and again with `-- --baseline`) compares memory over 2,400 short-lived workers with
and without the addon, to show worker churn leaks nothing.

### Project layout

| Path | What it holds |
|---|---|
| `src/index.ts` | The public API: JSON and raw views over the native cache, plus argument checks |
| `native/src/bindings.rs` | The napi surface `src/index.ts` calls |
| `native/src/config.rs` | Option validation and defaults |
| `native/src/store.rs` | One cache: lookups, the per-entry size limit, stats |
| `native/src/counters.rs` | Hit and miss counts that threads bump without contending |
| `native/src/registry.rs` | The process-wide map from cache name to store |
| `lib/` | Build output: `index.js` and `index.d.ts` from `tsc`, the built `.node` file, and the loader napi-rs generates (`binding.js`, `binding.d.ts`, committed so TypeScript compiles without a Rust build) |
| `npm/` | One package per platform, each publishing that platform's `.node` file |
| `test/`, `bench/` | `node:test` suites, type checks and throughput benchmarks |
| `.github/workflows/ci.yml` | Native builds and tests per platform, lint, coverage, type checks, and publishing |

### Releasing (maintainers)

```sh
npm version minor   # bumps package.json and every npm/<platform>/package.json, commits, tags
git push --follow-tags
```

The tag reruns every check, then the `publish` job waits for approval of the `npm` environment (the run's
**Review deployments** button). Once approved, it publishes the 7 platform packages, then
`worker-shared-cache` pinned to them.

## License

[MIT](LICENSE) © 2026 Dave Tonge
