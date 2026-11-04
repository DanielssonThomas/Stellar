use super::{
    contracts::*,
    media_host::{Commit, MediaHost, MediaPort},
};
use std::cell::Cell;

// Linked only by the qualification executable; no Windows adapter is linked here.
struct FixtureMedia {
    calls: Cell<usize>,
}
impl MediaPort for FixtureMedia {
    fn snapshot(&self) -> Result<ReflexMediaState, ()> {
        Ok(ReflexMediaState {
            ticket: String::new(),
            player: Some("fixture-only".into()),
            title: Some("synthetic track".into()),
            playing: true,
            volume: Some(50),
            muted: Some(false),
            endpoint_id: Some("no-real-device".into()),
            actions: [
                "play",
                "pause",
                "next",
                "previous",
                "volume_up",
                "volume_down",
                "mute",
                "unmute",
                "inspect",
            ]
            .map(String::from)
            .to_vec(),
        })
    }
    fn execute(
        &self,
        _: &ReflexMediaAction,
        _: &ReflexMediaState,
        commit: &Commit<'_>,
    ) -> ReflexMediaResult {
        if !commit(&mut || self.calls.set(self.calls.get() + 1)) {
            return ReflexMediaResult::Rejected;
        }
        ReflexMediaResult::Confirmed
    }
}

pub fn dispatch(plan: &ReflexPlan, input_id: &str) -> Option<bool> {
    if plan.route != ReflexRoute::Action {
        return None;
    }
    let action: ReflexMediaAction = serde_json::from_value(serde_json::json!(
        plan.action_id.as_ref()?.strip_prefix("media.")?
    ))
    .ok()?;
    let host = MediaHost::default();
    let port = FixtureMedia {
        calls: Cell::new(0),
    };
    let ticket = host.snapshot(&port).ok()?.ticket;
    let result = host.execute(
        &ReflexMediaRequest {
            version: 1,
            input_id: input_id.into(),
            ticket,
            action,
        },
        &port,
    );
    Some(matches!(result, ReflexMediaResult::Confirmed) && port.calls.get() == 1)
}
