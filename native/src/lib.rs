//! A byte-bounded cache per name, shared by every Node worker thread in the process.
//!
//! - [`config`]: the options a cache is opened with, validated and with defaults filled in.
//! - [`store`]: one cache, its per-entry size limit and its hit/miss counts.
//! - [`registry`]: the process-wide map from cache name to store.
//! - [`bindings`]: the napi surface that `lib/index.js` wraps.

mod bindings;
mod config;
mod counters;
mod registry;
mod store;

// musl's malloc is slow when many threads allocate at once; mimalloc is not. (macOS refuses to dlopen it.)
#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;
