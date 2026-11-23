//! Hit and miss counts that many threads bump without contending.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed};

const SLOTS: usize = 64;

thread_local! {
    /// The slot this thread counts in; threads take slots round-robin.
    static SLOT: usize = {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        NEXT.fetch_add(1, Relaxed) % SLOTS
    };
}

/// The counts for the threads sharing one slot, alone on a cache line so threads in other slots don't
/// stall on it. (128 bytes covers the adjacent-line prefetch on x86 and the larger lines on Apple chips.)
#[derive(Default)]
#[repr(align(128))]
struct Slot {
    hits: AtomicU64,
    misses: AtomicU64,
}

pub struct Counters([Slot; SLOTS]);

impl Counters {
    pub fn new() -> Self {
        Self(std::array::from_fn(|_| Slot::default()))
    }

    pub fn record(&self, hit: bool) {
        let slot = &self.0[SLOT.with(|slot| *slot)];
        let count = if hit { &slot.hits } else { &slot.misses };
        count.fetch_add(1, Relaxed);
    }

    /// Totals across every slot, as `(hits, misses)`.
    pub fn totals(&self) -> (u64, u64) {
        self.0.iter().fold((0, 0), |(hits, misses), slot| {
            (hits + slot.hits.load(Relaxed), misses + slot.misses.load(Relaxed))
        })
    }
}
