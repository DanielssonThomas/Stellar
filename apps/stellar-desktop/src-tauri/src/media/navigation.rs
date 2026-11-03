use super::contracts::{BrowserEvent, BrowserLoadState, MediaError};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU32, Ordering},
};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

struct PreviousDocument {
    id: Option<String>,
    url: String,
    same_document: bool,
}
pub struct Navigation {
    generation: AtomicU32,
    previous: Mutex<Option<PreviousDocument>>,
}
impl Navigation {
    pub fn new(generation: u32) -> Self {
        Self {
            generation: AtomicU32::new(generation),
            previous: Mutex::new(None),
        }
    }
    pub fn generation(&self) -> u32 {
        self.generation.load(Ordering::SeqCst)
    }
    fn settle(&self, generation: u32) {
        if let Ok(mut previous) = self.previous.lock()
            && self.generation() == generation
        {
            *previous = None;
        }
    }
    pub fn accepts(&self, generation: u32, document: &str, url: &str) -> bool {
        generation == self.generation()
            && !document.is_empty()
            && self.previous.lock().is_ok_and(|previous| {
                previous.as_ref().is_none_or(|old| {
                    old.id.as_deref() != Some(document) || old.same_document && old.url != url
                })
            })
    }
    pub async fn advance(
        &self,
        view: &tauri::Webview,
        generation: u32,
        same_document: bool,
    ) -> Result<(), MediaError> {
        if generation == 0 || generation <= self.generation() {
            return Err(MediaError::Malformed);
        }
        let (send, receive) = oneshot::channel();
        let send = Mutex::new(Some(send));
        view.eval_with_callback(
            "({document:window.__stellarDocumentId ?? null,url:location.href})",
            move |value| {
                if let Ok(mut send) = send.lock()
                    && let Some(send) = send.take()
                {
                    let _ = send.send(value);
                }
            },
        )
        .map_err(|_| MediaError::Unavailable)?;
        let value = tokio::time::timeout(std::time::Duration::from_secs(2), receive)
            .await
            .map_err(|_| MediaError::Unavailable)?
            .map_err(|_| MediaError::Unavailable)?;
        let value: serde_json::Value =
            serde_json::from_str(&value).map_err(|_| MediaError::Unavailable)?;
        let document = value["document"].as_str().map(str::to_owned);
        let url = value["url"]
            .as_str()
            .ok_or(MediaError::Unavailable)?
            .to_owned();
        if document.as_ref().is_some_and(|id| id.len() > 64) || url.len() > 8192 {
            return Err(MediaError::Unavailable);
        }
        let mut previous = self.previous.lock().map_err(|_| MediaError::Unavailable)?;
        if generation <= self.generation() {
            return Err(MediaError::Malformed);
        }
        *previous = Some(PreviousDocument {
            id: document,
            url,
            same_document,
        });
        self.generation.store(generation, Ordering::SeqCst);
        Ok(())
    }
    pub fn publish(view: tauri::Webview, id: String, owner: Arc<Self>) {
        let Ok(url) = view.url() else {
            return;
        };
        let generation = owner.generation();
        let current = view.clone();
        let app = view.app_handle().clone();
        // Fixed metadata-only probe in the unprivileged page; callers cannot supply code.
        let _=view.eval_with_callback("({document:window.__stellarDocumentId ?? '',url:location.href,state:document.readyState !== 'complete' ? 'pending' : location.protocol === 'https:' && ['text/html','application/xhtml+xml','text/plain'].includes(document.contentType) && !!document.body ? 'ready' : 'failed'})",move|result|{
            let Ok(value)=serde_json::from_str::<serde_json::Value>(&result) else{return;};
            let document=value["document"].as_str().unwrap_or("");let state=value["state"].as_str().unwrap_or("pending");
            if state!="pending" && owner.accepts(generation,document,url.as_str()) && value["url"].as_str()==Some(url.as_str()) && current.url().is_ok_and(|current|current==url) {
                let event=BrowserEvent{id:id.clone(),generation,url:url.as_str().chars().take(2048).collect(),state:BrowserLoadState::Loading};
                if state=="ready" {owner.settle(generation);}
                let _=app.emit_to("main","stellar-browser",event.clone());
                let _=app.emit_to("main","stellar-browser",BrowserEvent{state:if state=="ready"{BrowserLoadState::Ready}else{BrowserLoadState::Failed},..event});
            }
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_documents_cannot_complete_a_reload_but_changed_same_document_urls_can_settle() {
        let owner = Navigation::new(2);
        *owner.previous.lock().unwrap() = Some(PreviousDocument {
            id: Some("old".into()),
            url: "https://example.com/".into(),
            same_document: false,
        });
        assert!(!owner.accepts(2, "old", "https://example.com/"));
        assert!(!owner.accepts(1, "new", "https://example.com/"));
        assert!(owner.accepts(2, "new", "https://example.com/"));
        owner
            .previous
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .same_document = true;
        assert!(!owner.accepts(2, "old", "https://example.com/"));
        assert!(owner.accepts(2, "old", "https://example.com/#next"));
        assert!(owner.accepts(2, "old", "https://example.com/spa-route"));
        owner.settle(2);
        assert!(owner.accepts(2, "old", "https://example.com/"));
        assert!(!owner.accepts(1, "old", "https://example.com/"));
    }
}
