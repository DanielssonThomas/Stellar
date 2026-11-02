pub mod contracts;
mod process;

mod host;
use contracts::{CleanupReply, CleanupRequest};
pub use host::CleanupHost;

struct Lease(CleanupHost);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.finish();
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
    if !host.reserve() {
        return Ok(CleanupReply {
            version: 1,
            text: None,
        });
    }
    let lease = Lease(host.inner().clone());
    let text =
        tauri::async_runtime::spawn_blocking(move || process::refine(&request.raw, &lease.0))
            .await
            .ok()
            .flatten();
    Ok(CleanupReply { version: 1, text })
}
