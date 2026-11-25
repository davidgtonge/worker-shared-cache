//! One named cache.

use std::sync::Arc;

use quick_cache::sync::{Cache, DefaultLifecycle};
use quick_cache::{DefaultHashBuilder, Weighter};

use crate::config::{Config, Settings};
use crate::counters::Counters;

pub type Bytes = Arc<[u8]>;

/// Memory an entry costs beyond its key and value bytes: the key's and value's allocations and headers,
/// the cache's slot for it, its hash-table slot, and the space kept to remember recently evicted keys.
/// Measured at about 200 bytes for small entries on 64-bit platforms, so with this counted `maxBytes`
/// approximates memory even for tiny entries; allocator rounding adds up to about 1.5x on top. It also means no entry weighs zero, which `quick_cache` would never evict.
pub const ENTRY_OVERHEAD_BYTES: u64 = 192;

/// Weighs an entry by the bytes of its key and value plus [`ENTRY_OVERHEAD_BYTES`].
#[derive(Clone)]
struct ByteWeigher;

impl Weighter<String, Bytes> for ByteWeigher {
    fn weight(&self, key: &String, value: &Bytes) -> u64 {
        entry_bytes(key, value) + ENTRY_OVERHEAD_BYTES
    }
}

fn entry_bytes(key: &str, value: &[u8]) -> u64 {
    (key.len() + value.len()) as u64
}

pub struct Store {
    cache: Cache<String, Bytes, ByteWeigher>,
    settings: Settings,
    max_entry_bytes: u64,
    counters: Counters,
}

pub struct Stats {
    pub entries: usize,
    pub bytes: u64,
    pub hits: u64,
    pub misses: u64,
}

impl Store {
    /// Fails when no entry could fit: each shard's share of `max_bytes` is smaller than the overhead of one
    /// entry.
    pub fn new(config: &Config) -> Result<Self, String> {
        let cache = Cache::with_options(
            config.options(),
            ByteWeigher,
            DefaultHashBuilder::default(),
            DefaultLifecycle::default(),
        );
        let settings = Settings { shards: cache.num_shards(), ..config.settings() };
        let max_entry_bytes = max_entry_bytes(&cache, config.hot_allocation);
        if max_entry_bytes == 0 {
            return Err(format!(
                "maxBytes {} leaves no room for an entry: each of its {} shards gets {} bytes, and every \
                 entry costs {ENTRY_OVERHEAD_BYTES} bytes of bookkeeping besides its key and value. Raise \
                 maxBytes or lower shards.",
                config.max_bytes,
                settings.shards,
                cache.shard_capacity()
            ));
        }
        Ok(Self { cache, settings, max_entry_bytes, counters: Counters::new() })
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// The largest key plus value the cache will hold. Each shard holds an equal part of `max_bytes`, and
    /// `quick_cache` won't admit an entry (with its overhead) bigger than a shard's hot allocation.
    pub fn max_entry_bytes(&self) -> u64 {
        self.max_entry_bytes
    }

    pub fn shards(&self) -> usize {
        self.settings.shards
    }

    pub fn get(&self, key: &str) -> Option<Bytes> {
        let found = self.cache.get(key);
        self.counters.record(found.is_some());
        found
    }

    /// Stores the entry, or returns `false` without storing it when it exceeds [`Self::max_entry_bytes`].
    /// A rejected entry also drops any older value for the key, so it can't be read back as current.
    pub fn insert(&self, key: String, value: Bytes) -> bool {
        if entry_bytes(&key, &value) > self.max_entry_bytes {
            self.cache.remove(&key);
            return false;
        }
        self.cache.insert(key, value);
        true
    }

    pub fn stats(&self) -> Stats {
        let (hits, misses) = self.counters.totals();
        Stats { entries: self.cache.len(), bytes: self.cache.weight(), hits, misses }
    }
}

// Mirrors how `quick_cache` sizes a shard's hot allocation; float to integer is the rounding it uses too.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_precision_loss)]
fn max_entry_bytes(cache: &Cache<String, Bytes, ByteWeigher>, hot_allocation: f64) -> u64 {
    let shard = cache.shard_capacity();
    let admitted = ((shard as f64 * hot_allocation) as u64).clamp(shard.min(1), shard);
    admitted.saturating_sub(ENTRY_OVERHEAD_BYTES)
}
