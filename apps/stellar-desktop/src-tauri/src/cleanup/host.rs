use std::{
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct State {
    closed: bool,
    busy: bool,
    child: Option<Child>,
}

#[derive(Clone, Default)]
pub struct CleanupHost(Arc<Mutex<State>>);

impl CleanupHost {
    pub fn reserve(&self) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if state.closed || state.busy {
            return false;
        }
        state.busy = true;
        true
    }

    pub fn spawn(&self, mut command: Command) -> Option<(ChildStdin, ChildStdout)> {
        let mut state = self.0.lock().ok()?;
        if state.closed || !state.busy || state.child.is_some() {
            return None;
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().ok()?;
        let input = child.stdin.take();
        let output = child.stdout.take();
        state.child = Some(child);
        Some((input?, output?))
    }

    pub fn finish(&self) {
        if let Ok(mut state) = self.0.lock()
            && stop_child(&mut state)
        {
            state.busy = false;
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.closed = true;
            if stop_child(&mut state) {
                state.busy = false;
            }
        }
    }
}

fn stop_child(state: &mut State) -> bool {
    if let Some(child) = state.child.as_mut() {
        let _ = child.kill();
        if child.wait().is_err() {
            return false;
        }
        state.child = None;
    }
    true
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn shutdown_reaps_owned_child_and_seals_future_admission() {
        let host = CleanupHost::default();
        assert!(host.reserve());
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "cleanup::host::tests::inert_child", "--ignored"]);
        let (stdin, stdout) = host.spawn(command).expect("inert child starts");
        drop(stdin);
        host.shutdown();
        let mut bytes = Vec::new();
        use std::io::Read;
        stdout
            .take(32)
            .read_to_end(&mut bytes)
            .expect("child pipe closes after reap");
        let state = host.0.lock().unwrap();
        assert!(state.closed);
        assert!(state.child.is_none());
        drop(state);
        assert!(!host.reserve());
        host.finish();
        assert!(!host.reserve());
    }

    #[test]
    #[ignore]
    fn inert_child() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn shutdown_before_launch_prevents_start() {
        let host = CleanupHost::default();
        assert!(host.reserve());
        host.shutdown();
        assert!(host.spawn(Command::new("cmd.exe")).is_none());
    }
}
