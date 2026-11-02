pub mod contracts;
mod process;

use contracts::{CleanupReply, CleanupRequest};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub struct CleanupHost(Arc<AtomicBool>);

struct Lease(Arc<AtomicBool>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn cleanup_refine(
    host: tauri::State<'_, CleanupHost>,
    request: Option<serde_json::Value>,
) -> Result<CleanupReply, ()> {
    let request = request.and_then(|value| serde_json::from_value::<CleanupRequest>(value).ok());
    let Some(request) =
        request.filter(|r| r.version == 1 && !r.raw.trim().is_empty() && r.raw.len() <= 8192)
    else {
        return Ok(CleanupReply {
            version: 1,
            text: None,
        });
    };
    if host
        .0
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(CleanupReply {
            version: 1,
            text: None,
        });
    }
    let lease = Lease(host.0.clone());
    let text = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        process::refine(&request.raw)
    })
    .await
    .ok()
    .flatten();
    Ok(CleanupReply { version: 1, text })
}
