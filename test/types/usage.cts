// Compiled against the packed package by check.sh. Valid usage must compile, and every expect-error
// directive below must find an error (TypeScript fails the build if one doesn't).
import { openCache, SharedCache, type CacheOptions, type Stats } from "worker-shared-cache"

const options: CacheOptions = { shards: 8, hotAllocation: 0.9 }
const cache: SharedCache = openCache('users', 64 * 1024 * 1024, options)
cache.set('u:1', { id: 1 })
const user = cache.get<{ id: number }>('u:1')
const id: number | undefined = user?.id
const raw: Buffer | undefined = cache.getBuffer('u:1')
cache.setBuffer('b', new Uint8Array(4))
const stats: Stats = cache.stats()
const total: number = cache.maxEntryBytes + cache.shards + stats.hits

// @ts-expect-error a SharedCache comes only from openCache
new SharedCache()
// @ts-expect-error read-only
cache.shards = 4
// @ts-expect-error unknown option
openCache('x', 1, { shard: 4 })
// @ts-expect-error keys are strings
cache.get(1)
// @ts-expect-error the native handle is private
cache.native
// @ts-expect-error the internal factory is not in the declarations
SharedCache.fromNative

export { id, raw, total }
