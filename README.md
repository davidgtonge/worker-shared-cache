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
different `maxBytes` throws.

### JSON or raw bytes

- `get` / `set` run values through `JSON.stringify` / `JSON.parse`. The JSON text crosses into native code as
  a string, so a read costs little more than `JSON.parse` itself. `set` throws for values with no JSON form
  (`undefined`, functions, `BigInt`), and `get` returns `undefined` on a miss, so a stored `null` stays `null`.
- `getBuffer` / `setBuffer` store bytes untouched. Use them for binary data or your own encoding, such as
  `v8.serialize` when values hold `Date`, `Map`, `Set` or `BigInt`.

Both views share one store: `getBuffer` on a key written by `set` returns its UTF-8 JSON, and `get` on a key
written by `setBuffer` parses the bytes as JSON.

### Batch reads

`getPacked(keys)` looks up many keys' raw bytes in one native call and returns a single `Buffer`: for each key, a
`u32` little-endian length followed by that many bytes, or `0xffffffff` with no bytes for a miss.

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
npm run bench:serialize                    # JSON vs v8.serialize for a 10-key object
```

This prints single-thread throughput next to a plain `Map` baseline, then the combined throughput of 1..N
worker threads for get hits, get misses, and a 90/10 get/set mix.

## Development

```sh
npm install
npm run build   # release build of the native addon for this platform
npm test
```

## License

MIT
