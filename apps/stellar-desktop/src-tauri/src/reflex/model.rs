use super::{contracts::*, prompt};
use crate::owned_child::OwnedChild;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Default)]
struct State {
    child: Option<OwnedChild>,
    busy: Option<String>,
    touched: Option<Instant>,
    closed: bool,
    disabled: bool,
    generation: u64,
    key: String,
}

#[derive(Clone, Default)]
pub struct ReflexHost(Arc<Mutex<State>>);

impl ReflexHost {
    pub fn set_enabled(&self, enabled: bool) {
        if let Ok(mut s) = self.0.lock() {
            s.disabled = !enabled;
            if !enabled {
                s.generation = s.generation.saturating_add(1);
                stop(&mut s);
                s.busy = None;
            }
        }
    }
    pub fn cancel(&self, id: Option<&str>) {
        if let Ok(mut s) = self.0.lock() {
            if id.is_some() && s.busy.as_deref() != id {
                return;
            }
            s.generation = s.generation.saturating_add(1);
            stop(&mut s);
            s.busy = None;
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut s) = self.0.lock() {
            s.closed = true;
            s.generation = s.generation.saturating_add(1);
            stop(&mut s);
            s.busy = None;
        }
    }

    pub async fn infer(&self, request: &ReflexRequest) -> Option<ReflexPlan> {
        if !prompt::valid_request(request) {
            return None;
        }
        if !self.0.lock().is_ok_and(|s| !s.closed && !s.disabled) {
            return None;
        }
        if let Some(plan) = super::admission::delegation(request) {
            return Some(plan);
        }
        let generation = {
            let mut s = self.0.lock().ok()?;
            if s.closed || s.disabled || s.busy.is_some() {
                return None;
            }
            s.busy = Some(request.input_id.clone());
            s.touched = Some(Instant::now());
            s.generation
        };
        let response = self.run(request, generation).await;
        let transport_failed = response.is_none();
        let result = response.flatten();
        self.settle(generation, transport_failed)
            .then_some(result)
            .flatten()
    }

    fn settle(&self, generation: u64, failed: bool) -> bool {
        let Ok(mut s) = self.0.lock() else {
            return false;
        };
        if s.closed || s.disabled || s.generation != generation {
            return false;
        }
        s.busy = None;
        s.touched = Some(Instant::now());
        if failed {
            stop(&mut s);
        }
        true
    }

    fn install(&self, generation: u64, child: OwnedChild, key: String) -> Option<()> {
        let mut s = self.0.lock().ok()?;
        if s.closed || s.disabled || s.generation != generation {
            return None;
        }
        s.key = key;
        s.child = Some(child);
        Some(())
    }

    fn cancel_generation(&self, generation: u64) {
        if let Ok(mut s) = self.0.lock()
            && s.generation == generation
        {
            s.generation = s.generation.saturating_add(1);
            s.busy = None;
            stop(&mut s);
        }
    }

    async fn ready(&self, generation: u64) -> Option<(reqwest::Client, String)> {
        let host = self.clone();
        let (started, key) = tauri::async_runtime::spawn_blocking(move || {
            {
                let mut s = host.0.lock().ok()?;
                if s.closed || s.generation != generation {
                    return None;
                }
                if s.child
                    .as_mut()
                    .is_some_and(|c| c.try_wait().ok().flatten().is_some())
                {
                    stop(&mut s);
                }
                if s.child.is_some() {
                    return Some((false, s.key.clone()));
                }
            }
            let key = super::setup::token()?;
            let child = super::process::launch(&key, &|| host.current(generation))?;
            host.install(generation, child, key.clone())?;
            Some((true, key))
        })
        .await
        .ok()??;
        if started {
            let weak = Arc::downgrade(&self.0);
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    let Some(shared) = weak.upgrade() else {
                        break;
                    };
                    let Ok(mut s) = shared.lock() else {
                        break;
                    };
                    if s.closed {
                        stop(&mut s);
                        break;
                    }
                    if s.busy.is_none()
                        && s.touched
                            .is_some_and(|t| t.elapsed() >= Duration::from_secs(60))
                    {
                        stop(&mut s);
                        break;
                    }
                    if s.child.is_none() {
                        break;
                    }
                }
            });
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .ok()?;
        let start = Instant::now();
        loop {
            if !self.current(generation) {
                return None;
            }
            if client
                .get("http://127.0.0.1:18439/health")
                .bearer_auth(&key)
                .send()
                .await
                .ok()
                .is_some_and(|r| r.status().is_success())
            {
                break;
            }
            if start.elapsed() > Duration::from_secs(20) {
                self.cancel_generation(generation);
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Some((client, key))
    }

    async fn run(&self, request: &ReflexRequest, generation: u64) -> Option<Option<ReflexPlan>> {
        let (client, key) = self.ready(generation).await?;
        let mut response = client
            .post("http://127.0.0.1:18439/v1/chat/completions")
            .bearer_auth(key)
            .header("Content-Type", "application/json")
            .body(prompt::payload(request).to_string())
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > 8192 || !self.current(generation) {
                return None;
            }
            bytes.extend(chunk);
        }
        Some(prompt::decode(&bytes, request))
    }

    fn current(&self, generation: u64) -> bool {
        self.0
            .lock()
            .is_ok_and(|s| !s.closed && s.generation == generation)
    }
}

fn stop(s: &mut State) {
    if let Some(mut child) = s.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for State {
    fn drop(&mut self) {
        stop(self);
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod settings_tests;

#[cfg(all(test, windows))]
#[path = "preparation_tests.rs"]
mod preparation_tests;

#[path = "preparation.rs"]
mod preparation;
