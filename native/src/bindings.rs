//! The napi surface. `lib/index.js` wraps it to add JSON encoding and JS-side argument checks.

// napi hands every argument over as an owned value, used or not.
#![allow(clippy::needless_pass_by_value)]

use std::sync::Arc;

use napi::bindgen_prelude::{Buffer, BufferSlice};
use napi::{Env, Error, JsString, Result};
use napi_derive::napi;

use crate::config::Config;
use crate::registry;
use crate::store::Store;

#[napi(object)]
pub struct CacheOptions {
    pub shards: Option<f64>,
    pub hot_allocation: Option<f64>,
    pub estimated_entry_bytes: Option<f64>,
}

#[napi(object)]
pub struct Stats {
    pub entries: f64,
    pub bytes: f64,
    pub hits: f64,
    pub misses: f64,
}

#[napi]
pub struct NativeCache(Arc<Store>);

#[napi]
pub fn open_cache(name: String, max_bytes: f64, options: Option<CacheOptions>) -> Result<NativeCache> {
    let options =
        options.unwrap_or(CacheOptions { shards: None, hot_allocation: None, estimated_entry_bytes: None });
    let config =
        Config::new(max_bytes, options.shards, options.hot_allocation, options.estimated_entry_bytes)
            .map_err(Error::from_reason)?;
    registry::open(name, config).map(NativeCache).map_err(Error::from_reason)
}

// JS numbers are f64; every count here stays far below 2^53.
#[allow(clippy::cast_precision_loss)]
#[napi]
impl NativeCache {
    // Two read paths, because the step from cached bytes to a JS value dominates a read:
    //
    // - `get_buffer` copies into a Buffer that Node allocates. That is much cheaper than handing Node a
    //   Rust Vec, which registers a finalizer per Buffer, but making any Buffer still costs ~0.5 µs.
    // - `get_string` skips the Buffer and makes the JS string `JSON.parse` needs directly from the bytes,
    //   a plain copy for ASCII. Reading text this way is ~3.5x faster than `getBuffer().toString()`.
    //
    // Writes need only one path: `Buffer.from(text)` in JS then `set_buffer` costs the same as passing
    // the string in, since either way the text is encoded to UTF-8 once and copied once.

    /// The raw bytes, copied into a new Buffer.
    #[napi]
    pub fn get_buffer<'env>(&self, env: &'env Env, key: String) -> Result<Option<BufferSlice<'env>>> {
        self.0.get(&key).map(|bytes| BufferSlice::copy_from(env, bytes)).transpose()
    }

    /// Returns `false`, storing nothing, when the entry is over `maxEntryBytes`.
    #[napi]
    pub fn set_buffer(&self, key: String, value: Buffer) -> bool {
        self.0.insert(key, Arc::from(value.as_ref()))
    }

    /// The bytes as a JS string, made directly with no Buffer in between. Fails if they are not UTF-8.
    #[napi]
    pub fn get_string<'env>(&self, env: &'env Env, key: String) -> Result<Option<JsString<'env>>> {
        let Some(bytes) = self.0.get(&key) else { return Ok(None) };
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| Error::from_reason(format!("value for '{key}' is not UTF-8")))?;
        env.create_string(text).map(Some)
    }

    #[napi]
    pub fn stats(&self) -> Stats {
        let stats = self.0.stats();
        Stats {
            entries: stats.entries as f64,
            bytes: stats.bytes as f64,
            hits: stats.hits as f64,
            misses: stats.misses as f64,
        }
    }

    #[napi(getter)]
    pub fn max_entry_bytes(&self) -> f64 {
        self.0.max_entry_bytes() as f64
    }

    #[napi(getter)]
    pub fn shards(&self) -> u32 {
        u32::try_from(self.0.shards()).unwrap_or(u32::MAX)
    }
}
