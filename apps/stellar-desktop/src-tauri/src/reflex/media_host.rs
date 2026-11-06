use super::contracts::*;
use std::{collections::VecDeque, sync::Mutex};
pub type Commit<'a> = dyn Fn(&mut dyn FnMut()) -> bool + 'a;

pub trait MediaPort {
    fn snapshot(&self) -> Result<ReflexMediaState, ()>;
    fn execute(
        &self,
        action: &ReflexMediaAction,
        expected: &ReflexMediaState,
        commit: &Commit<'_>,
    ) -> ReflexMediaResult;
}

#[derive(Default)]
struct State {
    ticket: u64,
    snapshot: Option<ReflexMediaState>,
    seen: VecDeque<String>,
    epoch: u64,
    active: Option<String>,
    closed: bool,
    disabled: bool,
}

#[derive(Default)]
pub struct MediaHost(Mutex<State>);

impl MediaHost {
    pub fn set_enabled(&self, enabled: bool) {
        if let Ok(mut s) = self.0.lock() {
            s.disabled = !enabled;
            if !enabled {
                s.epoch = s.epoch.saturating_add(1);
                s.snapshot = None;
            }
        }
    }
    pub fn snapshot(&self, port: &impl MediaPort) -> Result<ReflexMediaState, ()> {
        let epoch = self.0.try_lock().map_err(|_| ())?.epoch;
        let mut snapshot = port.snapshot()?;
        let mut s = self.0.try_lock().map_err(|_| ())?;
        if s.closed || s.disabled || s.epoch != epoch || s.active.is_some() {
            return Err(());
        }
        s.ticket = s.ticket.checked_add(1).ok_or(())?;
        snapshot.ticket = s.ticket.to_string();
        s.snapshot = Some(snapshot.clone());
        Ok(snapshot)
    }

    #[cfg(test)]
    pub fn execute(&self, r: &ReflexMediaRequest, port: &impl MediaPort) -> ReflexMediaResult {
        self.execute_observed(r, port, |_, _, _| {})
    }

    pub fn execute_observed(
        &self,
        r: &ReflexMediaRequest,
        port: &impl MediaPort,
        observe: impl FnOnce(&ReflexMediaRequest, &ReflexMediaState, &ReflexMediaResult),
    ) -> ReflexMediaResult {
        let Ok(mut s) = self.0.try_lock() else {
            return ReflexMediaResult::Rejected;
        };
        if r.version != 1
            || s.closed
            || s.disabled
            || s.active.is_some()
            || !super::prompt::valid_id(&r.input_id)
            || s.seen.contains(&r.input_id)
        {
            return ReflexMediaResult::Rejected;
        }
        s.seen.push_back(r.input_id.clone());
        if s.seen.len() > 256 {
            s.seen.pop_front();
        }
        let Some(expected) = s.snapshot.take().filter(|v| v.ticket == r.ticket) else {
            return ReflexMediaResult::Rejected;
        };
        let action = serde_json::to_value(&r.action)
            .ok()
            .and_then(|v| v.as_str().map(String::from));
        if !action.is_some_and(|name| expected.actions.contains(&name)) {
            return ReflexMediaResult::Rejected;
        }
        let epoch = s.epoch;
        s.active = Some(r.input_id.clone());
        drop(s);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let current = || {
            self.0.lock().is_ok_and(|s| {
                !s.closed
                    && !s.disabled
                    && s.epoch == epoch
                    && s.active.as_deref() == Some(&r.input_id)
            }) && std::time::Instant::now() < deadline
        };
        let commit = |effect: &mut dyn FnMut()| {
            let Ok(s) = self.0.lock() else {
                return false;
            };
            if s.closed
                || s.disabled
                || s.epoch != epoch
                || s.active.as_deref() != Some(&r.input_id)
                || std::time::Instant::now() >= deadline
            {
                return false;
            }
            // Serialize cancellation against starting the OS operation, never its wait/readback.
            effect();
            true
        };
        let result = match port.snapshot() {
            Ok(mut snapshot) => {
                snapshot.ticket = expected.ticket.clone();
                if snapshot != expected || !current() {
                    ReflexMediaResult::Rejected
                } else {
                    port.execute(&r.action, &expected, &commit)
                }
            }
            Err(_) => ReflexMediaResult::Rejected,
        };
        if let Ok(mut s) = self.0.lock() {
            s.active = None;
        }
        // Receipt failures cannot revoke an effect or authorize a replay.
        observe(r, &expected, &result);
        result
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut s) = self.0.lock()
            && (s.active.is_none() || s.active.as_deref() == Some(id))
        {
            s.epoch = s.epoch.saturating_add(1);
            s.snapshot = None;
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut s) = self.0.lock() {
            s.closed = true;
            s.epoch = s.epoch.saturating_add(1);
            s.snapshot = None;
        }
    }
}

#[cfg(test)]
#[path = "media_tests.rs"]
mod tests;
