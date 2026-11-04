use super::*;
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};

fn inert() -> OwnedChild {
    let mut command = Command::new("python");
    command
        .args([
            "-I",
            "-u",
            "-c",
            "import time; print('ready',flush=True); time.sleep(30)",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = OwnedChild::spawn(command).unwrap();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready.trim(), "ready");
    child
}
fn assert_gone(pid: u32) {
    assert!(Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command",
        &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }} else {{ exit 0 }}")])
        .creation_flags(0x08000000).status().unwrap().success(), "Reflex child survived shutdown");
}

#[test]
fn startup_coalesces_and_shutdown_reaps_the_warmed_process() {
    tauri::async_runtime::block_on(async {
        let host = ReflexHost::default();
        let child = inert();
        let pid = child.id();
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (release, finish) = tokio::sync::oneshot::channel();
        let hosted = &host;
        let owner = host.prepare_with(|generation| async move {
            hosted.install(generation, child, "fixture".into()).unwrap();
            started.send(()).unwrap();
            finish.await.unwrap();
            true
        });
        let follower = async {
            waiting.await.unwrap();
            let join = host.prepare_with(|_| async { panic!("Duplicate model launch") });
            let release = async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                release.send(()).unwrap();
            };
            tokio::join!(join, release).0
        };
        let (owner, follower) = tokio::join!(owner, follower);
        assert!(owner && follower);
        host.shutdown();
        assert_gone(pid);
    });
}

#[test]
fn switching_off_during_preparation_kills_owned_work_and_rejects_late_readiness() {
    tauri::async_runtime::block_on(async {
        let host = ReflexHost::default();
        let child = inert();
        let pid = child.id();
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (release, finish) = tokio::sync::oneshot::channel();
        let hosted = &host;
        let prepare = host.prepare_with(|generation| async move {
            hosted.install(generation, child, "fixture".into()).unwrap();
            started.send(()).unwrap();
            finish.await.unwrap();
            true
        });
        let disable = async {
            waiting.await.unwrap();
            host.set_enabled(false);
            assert_gone(pid);
            release.send(()).unwrap();
        };
        let (ready, _) = tokio::join!(prepare, disable);
        assert!(!ready);
        assert!(host.0.lock().unwrap().child.is_none());
        assert!(
            !host
                .prepare_with(|_| async { panic!("Disabled startup") })
                .await
        );
    });
}

#[test]
fn closing_during_launch_reaps_a_late_child_and_never_resurrects_the_host() {
    tauri::async_runtime::block_on(async {
        let host = ReflexHost::default();
        let child = inert();
        let pid = child.id();
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (release, finish) = tokio::sync::oneshot::channel();
        let hosted = &host;
        let prepare = host.prepare_with(|generation| async move {
            started.send(()).unwrap();
            finish.await.unwrap();
            hosted
                .install(generation, child, "fixture".into())
                .is_some()
        });
        let close = async {
            waiting.await.unwrap();
            host.shutdown();
            host.set_enabled(true);
            release.send(()).unwrap();
        };
        let (ready, _) = tokio::join!(prepare, close);
        assert!(!ready);
        assert_gone(pid);
        assert!(
            !host
                .prepare_with(|_| async { panic!("Closed host restarted") })
                .await
        );
    });
}
