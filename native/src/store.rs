//! One named cache.

use std::sync::Arc;

use quick_cache::sync::{Cache, DefaultLifecycle};
use quick_cache::{DefaultHashBuilder, Weighter};

use crate::config::Config;
use crate::counters::Counters;

pub type Bytes = Arc<[u8]>;

/// Weighs an entry by the bytes of its key and value, so `max_bytes` bounds what the cache holds.
#[derive(Clone)]
struct ByteWeigher;

impl Weighter<String, Bytes> for ByteWeigher {
    fn weight(&self, key: &String, value: &Bytes) -> u64 {
        (key.len() + value.len()) as u64
    }
}

pub struct Store {
    cache: Cache<String, Bytes, ByteWeigher>,
    config: Config,
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
    pub fn new(config: Config) -> Self {
        let cache = Cache::with_options(
            config.options(),
            ByteWeigher,
            DefaultHashBuilder::default(),
            DefaultLifecycle::default(),
        );
        Self { max_entry_bytes: max_entry_bytes(&cache, &config), cache, config, counters: Counters::new() }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// The largest key plus value the cache will hold. Each shard holds an equal part of `max_bytes`, and
    /// `quick_cache` won't admit an entry bigger than a shard's hot allocation.
    pub fn max_entry_bytes(&self) -> u64 {
        self.max_entry_bytes
    }

    pub fn shards(&self) -> usize {
        self.cache.num_shards()
    }

    pub fn get(&self, key: &str) -> Option<Bytes> {
        let found = self.cache.get(key);
        self.counters.record(found.is_some());
        found
    }

    /// Stores the entry, or returns `false` without storing it when it exceeds [`Self::max_entry_bytes`].
    /// A rejected entry also drops any older value for the key, so it can't be read back as current.
    pub fn insert(&self, key: String, value: Bytes) -> bool {
        if (key.len() + value.len()) as u64 > self.max_entry_bytes {
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
fn max_entry_bytes(cache: &Cache<String, Bytes, ByteWeigher>, config: &Config) -> u64 {
    let shard = cache.shard_capacity();
    ((shard as f64 * config.hot_allocation) as u64).clamp(shard.min(1), shard)
}
