use super::{
    contracts::IvyErrorCode, lifecycle_contract::*, lifecycle_ports::*, lifecycle_receipt::*,
};
use serde::{Deserialize, Serialize};
use std::{cell::Cell, fs, io::Write, path::PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Phase {
    Pending,
    Claimed,
    Stopped,
    Finished,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    pub descriptor: Descriptor,
    pub receipt: Receipt,
    pub operation: String,
    pub transport: String,
    pub kind: IvyLifecycleKind,
    pub phase: Phase,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Custody {
    pub session: String,
    pub bind_uncertain: Option<String>,
    pub bindings: Vec<Binding>,
    pub intents: Vec<Intent>,
    pub denied: Vec<String>,
}

pub struct LifecycleCustody {
    pub(super) path: PathBuf,
    pub(super) state: Custody,
    pub(super) transport: String,
    _lock: fs::File,
    poisoned: Cell<bool>,
}

pub(super) fn operation() -> Result<String, IvyErrorCode> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| IvyErrorCode::Unavailable)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub(super) fn profile() -> &'static str {
    if cfg!(windows) {
        r"D:\Hermes\profiles\ivy"
    } else {
        "D:/Hermes/profiles/ivy"
    }
}

impl Custody {
    fn validate(&self, session: &str) -> Result<(), IvyErrorCode> {
        require(self.session == session && id(session, 512))?;
        require(
            self.bindings.len() <= 20
                && self.intents.len() <= 32
                && self.denied.len() <= 20
                && self.bind_uncertain.as_deref().is_none_or(|s| hex(s, 32)),
        )?;
        for (i, b) in self.bindings.iter().enumerate() {
            require(
                b.valid() && b.origin.session_id == session && b.origin.profile_id == profile(),
            )?;
            require(
                !self.bindings[..i]
                    .iter()
                    .any(|p| p.binding_id == b.binding_id),
            )?;
        }
        for (i, v) in self.intents.iter().enumerate() {
            let b = self
                .bindings
                .iter()
                .find(|b| b.binding_id == v.descriptor.binding_id)
                .ok_or(IvyErrorCode::Storage)?;
            require(v.descriptor.bound_to(b) && hex(&v.operation, 32) && hex(&v.transport, 32))?;
            Inspection {
                schema_version: 1,
                status: "terminal".into(),
                retry_authorized: false,
                descriptor: Some(v.descriptor.clone()),
                delivery_authorized: Some(true),
                receipt: Some(v.receipt.clone()),
            }
            .validate(&v.descriptor)?;
            require(!self.intents[..i].iter().any(|p| {
                p.operation == v.operation
                    || (p.descriptor.binding_id == v.descriptor.binding_id
                        && p.descriptor.event_id == v.descriptor.event_id
                        && p.kind == v.kind)
                    || ((p.receipt.admission_id == v.receipt.admission_id
                        || p.receipt.sequence == v.receipt.sequence
                        || (p.descriptor.binding_id == v.descriptor.binding_id
                            && p.descriptor.event_id == v.descriptor.event_id))
                        && (p.descriptor != v.descriptor || p.receipt != v.receipt))
            }))?;
        }
        for (i, b) in self.denied.iter().enumerate() {
            require(
                self.bindings.iter().any(|v| &v.binding_id == b) && !self.denied[..i].contains(b),
            )?;
        }
        Ok(())
    }
}

impl LifecycleCustody {
    /// transport is a native-generated per-connection nonce, never an RPC client label.
    /// Reopening never claims or transfers a prior transport's resources.
    pub fn open(path: PathBuf, session: &str, transport: &str) -> Result<Self, IvyErrorCode> {
        require(hex(transport, 32))?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_extension("custody.lock"))
            .map_err(|_| IvyErrorCode::Storage)?;
        lock.try_lock().map_err(|_| IvyErrorCode::Busy)?;
        let state = Self::read(&path, session)?;
        Ok(Self {
            path,
            state,
            transport: transport.into(),
            _lock: lock,
            poisoned: Cell::new(false),
        })
    }

    pub(super) fn read(path: &std::path::Path, session: &str) -> Result<Custody, IvyErrorCode> {
        let state = if path.exists() {
            if fs::metadata(path).map_err(|_| IvyErrorCode::Storage)?.len() > 16 * 1024 * 1024 {
                return Err(IvyErrorCode::Storage);
            }
            serde_json::from_slice(&fs::read(path).map_err(|_| IvyErrorCode::Storage)?)
                .map_err(|_| IvyErrorCode::Storage)?
        } else {
            Custody {
                session: session.into(),
                ..Custody::default()
            }
        };
        state.validate(session).map_err(|_| IvyErrorCode::Storage)?;
        Ok(state)
    }

    pub(super) fn save(&self) -> Result<(), IvyErrorCode> {
        if self.poisoned.get() {
            return Err(IvyErrorCode::Storage);
        }
        let result = self.write();
        if result.is_err() {
            self.poisoned.set(true);
        }
        result
    }

    fn write(&self) -> Result<(), IvyErrorCode> {
        self.state
            .validate(&self.state.session)
            .map_err(|_| IvyErrorCode::Storage)?;
        let bytes = serde_json::to_vec(&self.state).map_err(|_| IvyErrorCode::Storage)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(IvyErrorCode::Storage);
        }
        let tmp = self.path.with_extension("pending");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|_| IvyErrorCode::Storage)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| IvyErrorCode::Storage)?;
        fs::rename(tmp, &self.path).map_err(|_| IvyErrorCode::Storage)
    }

    pub(super) fn connection(&self, ports: &impl LifecyclePorts) -> Result<(), IvyErrorCode> {
        if self.poisoned.get() || ports.transport() != self.transport {
            return Err(IvyErrorCode::Uncertain);
        }
        Ok(())
    }
}
