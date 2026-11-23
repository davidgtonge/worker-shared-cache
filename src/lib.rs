//! A byte-bounded cache per name, shared by every Node worker thread in the process.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex, OnceLock};

use napi::Env;
use napi::bindgen_prelude::{Buffer, BufferSlice};
use napi_derive::napi;
use quick_cache::{Weighter, sync::Cache};

// musl's malloc is slow when 8 threads allocate at once; mimalloc is not. (macOS refuses to dlopen it.)
#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

type Bytes = Arc<[u8]>;

#[derive(Clone)]
struct Weigh;

impl Weighter<String, Bytes> for Weigh {
    fn weight(&self, key: &String, value: &Bytes) -> u64 {
        (key.len() + value.len()) as u64
    }
}

/// Hit and miss counts for the threads that map to one slot, padded to its own cache line so threads
/// counting in different slots don't stall each other.
#[derive(Default)]
#[repr(align(128))]
struct Counts {
    hits: AtomicU64,
    misses: AtomicU64,
}

const SLOTS: usize = 64;

thread_local! {
    static SLOT: usize = {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        NEXT.fetch_add(1, Relaxed) % SLOTS
    };
}

struct Shared {
    cache: Cache<String, Bytes, Weigh>,
    max_bytes: u64,
    counts: [Counts; SLOTS],
}

static CACHES: OnceLock<Mutex<HashMap<String, Arc<Shared>>>> = OnceLock::new();

#[napi(object)]
pub struct Stats {
    pub entries: f64,
    pub bytes: f64,
    pub hits: f64,
    pub misses: f64,
}

#[napi]
pub struct SharedCache(Arc<Shared>);

/// Opens the named cache, creating it on first use. Reopening with another size throws.
#[napi]
pub fn open_cache(name: String, max_bytes: f64) -> napi::Result<SharedCache> {
    let max_bytes = max_bytes as u64;
    let mut caches = CACHES.get_or_init(Default::default).lock().unwrap();
    if let Some(shared) = caches.get(&name) {
        if shared.max_bytes != max_bytes {
            let msg = format!("cache '{name}' is already open with maxBytes {}", shared.max_bytes);
            return Err(napi::Error::from_reason(msg));
        }
        return Ok(SharedCache(shared.clone()));
    }
    // The first argument only sizes the hash table: guess 1 KB entries.
    let cache = Cache::with_weighter((max_bytes / 1024).max(16) as usize, max_bytes, Weigh);
    let shared = Arc::new(Shared { cache, max_bytes, counts: std::array::from_fn(|_| Counts::default()) });
    caches.insert(name, shared.clone());
    Ok(SharedCache(shared))
}

#[napi]
impl SharedCache {
    fn lookup(&self, key: &str) -> Option<Bytes> {
        let found = self.0.cache.get(key);
        let counts = &self.0.counts[SLOT.with(|slot| *slot)];
        let count = if found.is_some() { &counts.hits } else { &counts.misses };
        count.fetch_add(1, Relaxed);
        found
    }

    // Returning a Buffer made from a Rust Vec registers a finalizer per call, which costs more than the
    // lookup itself; copying into memory Node allocates does not.
    #[napi]
    pub fn get<'env>(&self, env: &'env Env, key: String) -> napi::Result<Option<BufferSlice<'env>>> {
        self.lookup(&key).map(|bytes| BufferSlice::copy_from(env, bytes)).transpose()
    }

    #[napi]
    pub fn set(&self, key: String, value: Buffer) {
        self.0.cache.insert(key, Arc::from(value.as_ref()));
    }

    /// One Buffer for the whole batch: per key a u32 LE length (u32::MAX for a miss), then the bytes.
    #[napi]
    pub fn get_packed<'env>(&self, env: &'env Env, keys: Vec<String>) -> napi::Result<BufferSlice<'env>> {
        let mut out = Vec::new();
        for key in &keys {
            match self.lookup(key) {
                Some(bytes) => {
                    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                    out.extend_from_slice(&bytes);
                }
                None => out.extend_from_slice(&u32::MAX.to_le_bytes()),
            }
        }
        BufferSlice::copy_from(env, out)
    }

    #[napi]
    pub fn stats(&self) -> Stats {
        let cache = &self.0.cache;
        let sum = |pick: fn(&Counts) -> &AtomicU64| self.0.counts.iter().map(|c| pick(c).load(Relaxed)).sum::<u64>();
        Stats {
            entries: cache.len() as f64,
            bytes: cache.weight() as f64,
            hits: sum(|c| &c.hits) as f64,
            misses: sum(|c| &c.misses) as f64,
        }
    }
}
