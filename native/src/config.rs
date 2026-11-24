//! The options a cache is opened with.

use std::fmt;

use quick_cache::{Options, OptionsBuilder};

const DEFAULT_HOT_ALLOCATION: f64 = 0.97;
const DEFAULT_ESTIMATED_ENTRY_BYTES: u64 = 1024;
/// More shards than this only shrinks `maxEntryBytes` without reducing contention any further.
const MAX_SHARDS: f64 = 65_536.0;
/// The largest integer a JS number holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A cache's settings with defaults filled in. Every open of one name must agree on these.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub max_bytes: u64,
    /// Requested shard count; `quick_cache` rounds it to a power of two and may lower it for small caches.
    pub shards: usize,
    pub hot_allocation: f64,
    pub estimated_entry_bytes: u64,
}

impl Config {
    /// Validates what JS passed, filling in defaults for the options left out.
    pub fn new(
        max_bytes: f64,
        shards: Option<f64>,
        hot_allocation: Option<f64>,
        estimated_entry_bytes: Option<f64>,
    ) -> Result<Self, String> {
        let shards = match shards {
            Some(n) => usize::try_from(whole_number("shards", n, MAX_SHARDS)?).expect("at most MAX_SHARDS"),
            None => default_shards(),
        };
        let hot_allocation = hot_allocation.unwrap_or(DEFAULT_HOT_ALLOCATION);
        if !(hot_allocation > 0.0 && hot_allocation <= 1.0) {
            return Err(format!("hotAllocation must be above 0 and at most 1, got {hot_allocation}"));
        }
        Ok(Self {
            max_bytes: whole_number("maxBytes", max_bytes, MAX_SAFE_INTEGER)?,
            shards,
            hot_allocation,
            estimated_entry_bytes: match estimated_entry_bytes {
                Some(n) => whole_number("estimatedEntryBytes", n, MAX_SAFE_INTEGER)?,
                None => DEFAULT_ESTIMATED_ENTRY_BYTES,
            },
        })
    }

    pub fn options(&self) -> Options {
        OptionsBuilder::new()
            .weight_capacity(self.max_bytes)
            .estimated_items_capacity(
                usize::try_from(self.max_bytes / self.estimated_entry_bytes).unwrap_or(usize::MAX).max(1),
            )
            .shards(self.shards)
            .hot_allocation(self.hot_allocation)
            .build()
            .expect("every required option is set")
    }
}

impl fmt::Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "maxBytes {}, shards {}, hotAllocation {}, estimatedEntryBytes {}",
            self.max_bytes, self.shards, self.hot_allocation, self.estimated_entry_bytes
        )
    }
}

/// The same default as `quick_cache`, computed here so reopening with and without `shards` compares equal.
fn default_shards() -> usize {
    std::thread::available_parallelism().map_or(1, usize::from) * 4
}

/// Checks `n` is a whole number from 1 to `max`, as JS passes every number as an f64.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // checked to be a whole number in range
fn whole_number(name: &str, n: f64, max: f64) -> Result<u64, String> {
    if (1.0..=max).contains(&n) && n.fract() == 0.0 {
        Ok(n as u64)
    } else {
        Err(format!("{name} must be a whole number from 1 to {max}, got {n}"))
    }
}
