//! The process-wide map from cache name to store, which is what lets worker threads share caches.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use crate::config::Config;
use crate::store::Store;

static STORES: OnceLock<Mutex<HashMap<String, Arc<Store>>>> = OnceLock::new();

pub enum OpenError {
    /// The options can't make a usable cache.
    Invalid(String),
    /// The name is already open with settings that differ in effect.
    AlreadyOpen(String),
}

/// Returns the store named `name`, creating it on first use. Fails if it is already open with settings
/// that differ in effect. When several threads open a new name at once, the first to take the lock creates
/// it, so with conflicting options which settings win depends on timing.
pub fn open(name: String, config: &Config) -> Result<Arc<Store>, OpenError> {
    let mut stores = STORES.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(store) = stores.get(&name) {
        let requested = config.settings();
        if *store.settings() != requested {
            return Err(OpenError::AlreadyOpen(format!(
                "cache '{name}' is already open with {}; asked for {requested}",
                store.settings()
            )));
        }
        return Ok(Arc::clone(store));
    }
    let store = Arc::new(Store::new(config).map_err(OpenError::Invalid)?);
    stores.insert(name, Arc::clone(&store));
    Ok(store)
}
