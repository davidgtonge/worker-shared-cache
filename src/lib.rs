//! A byte-bounded cache per name, shared by every Node worker thread in the process.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::Buffer;
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

struct Shared {
    cache: Cache<String, Bytes, Weigh>,
    max_bytes: u64,
    hits: AtomicU64,
    misses: AtomicU64,
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
    let shared = Arc::new(Shared { cache, max_bytes, hits: AtomicU64::new(0), misses: AtomicU64::new(0) });
    caches.insert(name, shared.clone());
    Ok(SharedCache(shared))
}

#[napi]
impl SharedCache {
    fn lookup(&self, key: &str) -> Option<Bytes> {
        let found = self.0.cache.get(key);
        let count = if found.is_some() { &self.0.hits } else { &self.0.misses };
        count.fetch_add(1, Relaxed);
        found
    }

    #[napi]
    pub fn get(&self, key: String) -> Option<Buffer> {
        self.lookup(&key).map(|bytes| bytes.to_vec().into())
    }

    #[napi]
    pub fn set(&self, key: String, value: Buffer) {
        self.0.cache.insert(key, Arc::from(value.as_ref()));
    }

    /// One Buffer for the whole batch: per key a u32 LE length (u32::MAX for a miss), then the bytes.
    #[napi]
    pub fn get_packed(&self, keys: Vec<String>) -> Buffer {
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
        out.into()
    }

    #[napi]
    pub fn stats(&self) -> Stats {
        let cache = &self.0.cache;
        Stats {
            entries: cache.len() as f64,
            bytes: cache.weight() as f64,
            hits: self.0.hits.load(Relaxed) as f64,
            misses: self.0.misses.load(Relaxed) as f64,
        }
    }
}
