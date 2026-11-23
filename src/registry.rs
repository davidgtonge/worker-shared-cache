//! The process-wide map from cache name to store, which is what lets worker threads share caches.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use crate::config::Config;
use crate::store::Store;

static STORES: OnceLock<Mutex<HashMap<String, Arc<Store>>>> = OnceLock::new();

/// Returns the store named `name`, creating it on first use. Fails if it is already open with other settings.
pub fn open(name: String, config: Config) -> Result<Arc<Store>, String> {
    let mut stores = STORES.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(store) = stores.get(&name) {
        if *store.config() != config {
            return Err(format!(
                "cache '{name}' is already open with {}; asked for {config}",
                store.config()
            ));
        }
        return Ok(Arc::clone(store));
    }
    let store = Arc::new(Store::new(config));
    stores.insert(name, Arc::clone(&store));
    Ok(store)
}
