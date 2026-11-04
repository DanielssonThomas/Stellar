use super::{contracts::*, prompt};
use crate::owned_child::OwnedChild;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Default)]
struct State {
    child: Option<OwnedChild>,
    busy: Option<String>,
    touched: Option<Instant>,
    closed: bool,
    generation: u64,
    key: String,
}

#[derive(Clone, Default)]
pub struct ReflexHost(Arc<Mutex<State>>);

impl ReflexHost {
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
        if let Some(plan) = super::admission::delegation(request) {
            return Some(plan);
        }
        let generation = {
            let mut s = self.0.lock().ok()?;
            if s.closed || s.busy.is_some() {
                return None;
            }
            s.busy = Some(request.input_id.clone());
            s.touched = Some(Instant::now());
            s.generation
        };
        let response = self.run(request, generation).await;
        let transport_failed = response.is_none();
        let result = response.flatten();
        if let Ok(mut s) = self.0.lock() {
            if s.generation != generation {
                return None;
            }
            s.busy = None;
            s.touched = Some(Instant::now());
            if transport_failed {
                stop(&mut s);
            }
        }
        result
    }

    async fn run(&self, request: &ReflexRequest, generation: u64) -> Option<Option<ReflexPlan>> {
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
            let child = launch(&key, &|| host.current(generation))?;
            let mut s = host.0.lock().ok()?;
            if s.closed || s.generation != generation {
                return None;
            }
            s.key = key.clone();
            s.child = Some(child);
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
                self.cancel(Some(&request.input_id));
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
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

fn launch(key: &str, current: &dyn Fn() -> bool) -> Option<OwnedChild> {
    // Only explicitly configured, already installed files. Never download or reuse Hermes' GPU server.
    let model = PathBuf::from(std::env::var_os("STELLAR_REFLEX_MODEL")?);
    let binary = PathBuf::from(std::env::var_os("STELLAR_REFLEX_LLAMA")?);
    if !model.is_absolute() || !model.is_file() || !binary.is_absolute() || !binary.is_file() {
        return None;
    }
    super::setup::verify(&model)?;
    if !current() {
        return None;
    }
    let layers: u8 = std::env::var("STELLAR_REFLEX_GPU_LAYERS")
        .unwrap_or_else(|_| "0".into())
        .parse()
        .ok()?;
    if layers > 36 {
        return None;
    }
    // Refuse an occupied endpoint rather than borrowing an unrelated local process.
    let socket = std::net::TcpListener::bind("127.0.0.1:18439").ok()?;
    let mut command = Command::new(binary);
    command
        .arg("-m")
        .arg(model)
        .args([
            "--alias",
            "ivy-reflex",
            "--host",
            "127.0.0.1",
            "--port",
            "18439",
            "-c",
            "4096",
            "-np",
            "1",
            "-t",
            "4",
            "-tb",
            "4",
            "--prio",
            "-1",
            "-ngl",
            &layers.to_string(),
            "--jinja",
            "--reasoning",
            "off",
            "--chat-template-kwargs",
            "{\"enable_thinking\":false}",
            "--no-webui",
            "--api-key",
            key,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if layers == 0 {
        command.args(["--device", "none", "--no-kv-offload"]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000);
    }
    drop(socket);
    OwnedChild::spawn(command).ok()
}
