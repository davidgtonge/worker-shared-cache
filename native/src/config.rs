//! The options a cache is opened with.

use std::fmt;

use quick_cache::{Options, OptionsBuilder};

use crate::store::ENTRY_OVERHEAD_BYTES;

/// A fixed default rather than one per CPU, so a cache accepts the same entries on every machine: the
/// per-entry limit is about `maxBytes / shards`.
const DEFAULT_SHARDS: u64 = 64;
const DEFAULT_HOT_ALLOCATION: f64 = 0.97;
const DEFAULT_ESTIMATED_ENTRY_BYTES: u64 = 1024;
/// More shards than this only shrinks `maxEntryBytes` without reducing contention any further.
const MAX_SHARDS: f64 = 65_536.0;
/// The largest integer a JS number holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// `quick_cache` halves the shard count until each shard can hold about this many entries.
const MIN_ENTRIES_PER_SHARD: u64 = 32;

/// A cache's settings as requested, with defaults filled in.
#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub max_bytes: u64,
    pub shards: u64,
    pub hot_allocation: f64,
    pub estimated_entry_bytes: u64,
}

/// What a cache actually runs with. Reopening a name must agree on these, so options that differ only in
/// ways that make no difference (`shards: 30` and `shards: 32`, say) still match.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    pub max_bytes: u64,
    pub shards: usize,
    pub hot_allocation: f64,
}

impl Config {
    /// Validates what JS passed, filling in defaults for the options left out.
    pub fn new(
        max_bytes: f64,
        shards: Option<f64>,
        hot_allocation: Option<f64>,
        estimated_entry_bytes: Option<f64>,
    ) -> Result<Self, String> {
        let hot_allocation = hot_allocation.unwrap_or(DEFAULT_HOT_ALLOCATION);
        if !(hot_allocation > 0.0 && hot_allocation <= 1.0) {
            return Err(format!(
                "hotAllocation must be above 0 and at most 1, got {}",
                js_number(hot_allocation)
            ));
        }
        Ok(Self {
            max_bytes: whole_number("maxBytes", max_bytes, MAX_SAFE_INTEGER)?,
            shards: match shards {
                Some(n) => whole_number("shards", n, MAX_SHARDS)?,
                None => DEFAULT_SHARDS,
            },
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
            .estimated_items_capacity(usize::try_from(self.estimated_entries()).unwrap_or(usize::MAX))
            .shards(usize::try_from(self.shards).expect("at most MAX_SHARDS"))
            .hot_allocation(self.hot_allocation)
            .build()
            .expect("every required option is set")
    }

    /// The settings a cache opened with this config runs with. The shard count mirrors
    /// `quick_cache::sync::Cache::with_options`: rounded up to a power of two, then halved while a shard
    /// would hold fewer than 32 entries. The reopen tests check this agrees with the cache itself.
    pub fn settings(&self) -> Settings {
        let entries = self.estimated_entries();
        let mut shards = self.shards.next_power_of_two();
        while shards > 1 && entries.div_ceil(shards) < MIN_ENTRIES_PER_SHARD {
            shards /= 2;
        }
        Settings {
            max_bytes: self.max_bytes,
            shards: usize::try_from(shards).expect("at most MAX_SHARDS"),
            hot_allocation: self.hot_allocation,
        }
    }

    /// Entries are weighed with their bookkeeping overhead, so the estimate counts it too.
    fn estimated_entries(&self) -> u64 {
        (self.max_bytes / (self.estimated_entry_bytes + ENTRY_OVERHEAD_BYTES)).max(1)
    }
}

impl fmt::Display for Settings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "maxBytes {}, {} shards, hotAllocation {}",
            self.max_bytes,
            self.shards,
            js_number(self.hot_allocation)
        )
    }
}

/// Checks `n` is a whole number from 1 to `max`, as JS passes every number as an f64.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // checked to be a whole number in range
fn whole_number(name: &str, n: f64, max: f64) -> Result<u64, String> {
    if (1.0..=max).contains(&n) && n.fract() == 0.0 {
        Ok(n as u64)
    } else {
        Err(format!("{name} must be a whole number from 1 to {}, got {}", js_number(max), js_number(n)))
    }
}

/// Formats a number the way JS prints it in the cases that differ from Rust (Rust writes `inf` and `NaN`
/// and never uses exponents), so error messages show the value the caller passed.
fn js_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if n != 0.0 && !(1e-6..1e21).contains(&n.abs()) {
        let exponent = format!("{n:e}");
        if exponent.contains("e-") { exponent } else { exponent.replacen('e', "e+", 1) }
    } else {
        n.to_string()
    }
}
