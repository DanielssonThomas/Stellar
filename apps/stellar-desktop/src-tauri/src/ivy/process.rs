use super::contracts::IvyErrorCode;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};

pub type OwnedChild = Arc<Mutex<Option<Child>>>;
pub type SharedInput = Arc<Mutex<ChildStdin>>;
pub type WorkspaceCallback = Arc<dyn Fn(Value) -> Result<(), IvyErrorCode> + Send + Sync>;

pub fn control(input: &SharedInput, frame: &Value) -> Result<(), IvyErrorCode> {
    let mut line = serde_json::to_vec(frame).map_err(|_| IvyErrorCode::Protocol)?;
    line.push(b'\n');
    if line.len() > 16_384 {
        return Err(IvyErrorCode::MalformedRequest);
    }
    let mut writer = input.lock().map_err(|_| IvyErrorCode::Unavailable)?;
    writer
        .write_all(&line)
        .and_then(|_| writer.flush())
        .map_err(|_| IvyErrorCode::Unavailable)
}

pub fn request_line(sequence: u64, method: &str, params: &Value) -> Result<Vec<u8>, IvyErrorCode> {
    let mut line = serde_json::to_vec(&json!({"id":sequence,"method":method,"params":params}))
        .map_err(|_| IvyErrorCode::Protocol)?;
    line.push(b'\n');
    let limit = if method == "clarify.respond" {
        65_536
    } else {
        16_384
    };
    if line.len() > limit {
        return Err(IvyErrorCode::MalformedRequest);
    }
    Ok(line)
}
pub struct Broker {
    input: SharedInput,
    frames: Receiver<Result<Value, IvyErrorCode>>,
    child: OwnedChild,
    sequence: u64,
    deadline: Duration,
    workspace: Option<WorkspaceCallback>,
    image_endpoint: Option<super::workspace_data::SharedImageEndpoint>,
}

pub fn stop(child: &OwnedChild) {
    if let Ok(mut slot) = child.lock()
        && let Some(mut process) = slot.take()
    {
        let _ = process.kill();
        let _ = process.wait();
    }
}

impl Broker {
    pub fn launch(child: OwnedChild) -> Result<Self, IvyErrorCode> {
        let modules = [
            (
                "stellar_ivy_inspector_history",
                include_str!("ivy_inspector_history.py"),
            ),
            ("stellar_ivy_inspector", include_str!("ivy_inspector.py")),
            ("stellar_ivy_activity", include_str!("ivy_activity.py")),
            ("stellar_ivy_controls", include_str!("ivy_controls.py")),
            (
                "stellar_ivy_conversation",
                include_str!("ivy_conversation.py"),
            ),
            (
                "stellar_ivy_voice_expression",
                include_str!("ivy_voice_expression.py"),
            ),
            ("stellar_ivy_approvals", include_str!("ivy_approvals.py")),
            (
                "stellar_ivy_profile_tools",
                include_str!("ivy_profile_tools.py"),
            ),
            (
                "stellar_ivy_edit_policy",
                include_str!("ivy_edit_policy.py"),
            ),
            (
                "stellar_workspace_credentials",
                include_str!("workspace_credentials.py"),
            ),
            (
                "stellar_workspace_protocol",
                include_str!("workspace_protocol.py"),
            ),
            (
                "stellar_engineering_intelligence",
                include_str!("engineering_intelligence.py"),
            ),
            (
                "stellar_engineering_presentation",
                include_str!("engineering_presentation.py"),
            ),
            ("stellar_workspace_mcp", include_str!("workspace_mcp.py")),
            (
                "stellar_workspace_service",
                include_str!("workspace_service.py"),
            ),
        ];
        let mut program = String::from("import sys,types,contextlib\n");
        for (name, source) in modules {
            let quoted = serde_json::to_string(source).map_err(|_| IvyErrorCode::Protocol)?;
            program.push_str(&format!("_m=types.ModuleType('{name}');sys.modules['{name}']=_m\nwith contextlib.redirect_stdout(sys.stderr):\n exec({quoted},_m.__dict__)\n"));
        }
        let bridge = serde_json::to_string(include_str!("ivy_bridge.py"))
            .map_err(|_| IvyErrorCode::Protocol)?;
        program.push_str(&format!("exec({bridge},globals())\n"));
        let mut command = Command::new(super::runtime::python()?);
        command
            .args(["-I", "-u", "-c", "import sys;n=int(sys.stdin.buffer.readline());exec(compile(sys.stdin.buffer.read(n),'<stellar>','exec'),globals())"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("HERMES_TUI_GATEWAY_URL")
            .env_remove("PYTHONPATH");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let broker = Self::spawn(command, child)?;
        let mut writer = broker.input.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        writer
            .write_all(format!("{}\n", program.len()).as_bytes())
            .and_then(|_| writer.write_all(program.as_bytes()))
            .and_then(|_| writer.flush())
            .map_err(|_| IvyErrorCode::Unavailable)?;
        drop(writer);
        Ok(broker)
    }

    pub(super) fn spawn(mut command: Command, child: OwnedChild) -> Result<Self, IvyErrorCode> {
        let mut process = command.spawn().map_err(|_| IvyErrorCode::Unavailable)?;
        let input = process.stdin.take().ok_or(IvyErrorCode::Unavailable)?;
        let output = process.stdout.take().ok_or(IvyErrorCode::Unavailable)?;
        *child.lock().map_err(|_| IvyErrorCode::Unavailable)? = Some(process);
        let (sender, frames) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = vec![];
                let count = reader.read_until(b'\n', &mut line);
                let frame = match count {
                    Ok(0) => break,
                    Ok(_) if line.last() == Some(&b'\n') => {
                        serde_json::from_slice(&line).map_err(|_| IvyErrorCode::Protocol)
                    }
                    _ => Err(IvyErrorCode::Protocol),
                };
                let failed = frame.is_err();
                if sender.try_send(frame).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            input: Arc::new(Mutex::new(input)),
            frames,
            child,
            sequence: 0,
            deadline: Duration::from_secs(18),
            workspace: None,
            image_endpoint: None,
        })
    }

    pub fn set_workspace(
        &mut self,
        callback: WorkspaceCallback,
        endpoint: super::workspace_data::SharedImageEndpoint,
    ) {
        self.workspace = Some(callback);
        self.image_endpoint = Some(endpoint);
    }

    pub fn configure_workspace(
        &self,
        value: Value,
    ) -> Result<super::journal::WorkspaceDescriptor, IvyErrorCode> {
        super::workspace_data::configure(
            value,
            self.image_endpoint
                .as_ref()
                .ok_or(IvyErrorCode::Unavailable)?,
        )
    }

    pub fn input(&self) -> SharedInput {
        self.input.clone()
    }

    fn workspace_event(&self, frame: &Value) -> Result<bool, IvyErrorCode> {
        if frame.get("event").and_then(Value::as_str) != Some("workspace_tool") {
            return Ok(false);
        }
        self.workspace.as_ref().ok_or(IvyErrorCode::Unavailable)?(frame.clone())?;
        Ok(true)
    }

    pub fn poll(&self) -> Result<Option<Value>, IvyErrorCode> {
        match self.frames.try_recv() {
            Ok(frame) => {
                let frame = frame?;
                if self.workspace_event(&frame)? {
                    Ok(None)
                } else {
                    Ok(Some(frame))
                }
            }
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(IvyErrorCode::Unavailable),
        }
    }

    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        events: &mut Vec<Value>,
    ) -> Result<Value, IvyErrorCode> {
        #[cfg(feature = "native-smoke")]
        if std::env::var_os("STELLAR_BACKGROUND_SMOKE").is_some() {
            println!("STELLAR_SMOKE_STAGE bg-rpc-{}", method.replace('.', "-"));
        }
        self.sequence = self.sequence.checked_add(1).ok_or(IvyErrorCode::Protocol)?;
        let line = request_line(self.sequence, method, &params)?;
        {
            let mut writer = self.input.lock().map_err(|_| IvyErrorCode::Unavailable)?;
            writer
                .write_all(&line)
                .and_then(|_| writer.flush())
                .map_err(|_| IvyErrorCode::Unavailable)?;
        }
        let deadline = Instant::now() + self.deadline;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let frame = self
                .frames
                .recv_timeout(remaining)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => IvyErrorCode::Timeout,
                    mpsc::RecvTimeoutError::Disconnected => IvyErrorCode::Unavailable,
                })??;
            if self.workspace_event(&frame)? {
                continue;
            }
            if frame.get("id").and_then(Value::as_u64) == Some(self.sequence) {
                if let Some(error) = frame.get("error") {
                    #[cfg(feature = "native-smoke")]
                    if std::env::var_os("STELLAR_BACKGROUND_SMOKE").is_some() {
                        println!("STELLAR_SMOKE_STAGE bg-rpc-refused");
                    }
                    return Err(match error.get("code").and_then(Value::as_str) {
                        Some("busy") => IvyErrorCode::Busy,
                        Some("unavailable") => IvyErrorCode::Unavailable,
                        _ => IvyErrorCode::Uncertain,
                    });
                }
                return frame.get("result").cloned().ok_or(IvyErrorCode::Protocol);
            }
            if frame.get("id").is_some() || events.len() >= 32 {
                return Err(IvyErrorCode::Protocol);
            }
            events.push(frame);
        }
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        stop(&self.child);
    }
}

#[cfg(all(test, windows))]
#[path = "process_tests.rs"]
mod tests;
