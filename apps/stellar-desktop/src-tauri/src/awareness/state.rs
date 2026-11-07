use super::contracts::*;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) struct State {
    pub snapshot: AwarenessSnapshot,
    pub generation: u64,
    pub stopped: bool,
    pub workspace_at: u64,
}

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

pub(super) fn label(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(limit)
        .collect()
}

pub(super) fn recent(value: &str, now: u64, limit: u64) -> bool {
    value
        .parse::<u64>()
        .is_ok_and(|stamp| stamp <= now && now - stamp < limit)
}

impl State {
    pub fn new(enabled: bool) -> Self {
        let health = if enabled {
            AwarenessHealth::Unavailable
        } else {
            AwarenessHealth::Paused
        };
        Self {
            snapshot: AwarenessSnapshot {
                version: 1,
                revision: "0".into(),
                enabled,
                app_health: health.clone(),
                media_health: health,
                media_observed_at_ms: None,
                foreground: None,
                last_external: None,
                spotify: None,
                workspace: None,
            },
            generation: 0,
            stopped: false,
            workspace_at: 0,
        }
    }

    pub fn advance(&mut self) {
        self.snapshot.revision = self
            .snapshot
            .revision
            .parse::<u64>()
            .unwrap_or(0)
            .saturating_add(1)
            .to_string();
    }

    pub fn enabled(&mut self, enabled: bool) {
        self.generation = self.generation.saturating_add(1);
        let revision = self.snapshot.revision.clone();
        self.snapshot = State::new(enabled).snapshot;
        self.snapshot.revision = revision;
        self.workspace_at = 0;
        self.advance();
    }

    pub fn observe(
        &mut self,
        generation: u64,
        app: Result<AwarenessApp, ()>,
        media: Option<Result<Option<AwarenessMedia>, ()>>,
    ) -> bool {
        if self.stopped || !self.snapshot.enabled || generation != self.generation {
            return false;
        }
        match app {
            Ok(app) => {
                if !is_stellar(&app.app) {
                    self.snapshot.last_external = Some(app.clone());
                }
                self.snapshot.foreground = Some(app);
                self.snapshot.app_health = AwarenessHealth::Available;
            }
            Err(()) => {
                self.snapshot.foreground = None;
                self.snapshot.app_health = AwarenessHealth::Unavailable;
            }
        }
        if let Some(media) = media {
            match media {
                Ok(media) => {
                    self.snapshot.media_observed_at_ms = Some(now().to_string());
                    self.snapshot.spotify = media;
                    self.snapshot.media_health = AwarenessHealth::Available;
                }
                Err(()) => {
                    self.snapshot.media_observed_at_ms = None;
                    self.snapshot.spotify = None;
                    self.snapshot.media_health = AwarenessHealth::Unavailable;
                }
            }
        }
        self.advance();
        true
    }

    pub fn context(&self, epoch: &str, at: u64) -> Option<String> {
        if self.stopped || !self.snapshot.enabled {
            return None;
        }
        let snapshot = &self.snapshot;
        let foreground = snapshot
            .foreground
            .as_ref()
            .filter(|app| recent(&app.observed_at_ms, at, 5_000));
        let last_external = snapshot
            .last_external
            .as_ref()
            .filter(|app| recent(&app.observed_at_ms, at, 300_000));
        let media_fresh = snapshot.media_health == AwarenessHealth::Available
            && snapshot
                .media_observed_at_ms
                .as_ref()
                .is_some_and(|stamp| recent(stamp, at, 15_000));
        let spotify = snapshot
            .spotify
            .as_ref()
            .filter(|media| media_fresh && recent(&media.observed_at_ms, at, 15_000));
        let workspace = snapshot.workspace.as_ref().filter(|workspace| {
            let same_request = workspace.epoch == epoch
                || epoch
                    .parse::<u64>()
                    .ok()
                    .and_then(|value| value.checked_add(1))
                    .is_some_and(|next| workspace.epoch == next.to_string());
            same_request && at >= self.workspace_at && at - self.workspace_at < 15_000
        });
        let mut value = json!({
            "observed_at_ms": at.to_string(), "foreground":foreground, "last_external":last_external,
            "spotify":spotify, "app_state": if foreground.is_some() { "available" } else { "unavailable" },
            "spotify_state": if media_fresh { if spotify.is_some() { "available" } else if snapshot.spotify.is_none() { "no_local_session" } else { "unavailable" } } else { "unavailable" },
            "workspace":workspace,
        });
        loop {
            let text = serde_json::to_string(&value).ok()?;
            if text.len() <= 6_144 {
                return Some(text);
            }
            let panes = value.pointer_mut("/workspace/panes")?.as_array_mut()?;
            panes.pop()?;
        }
    }
}

fn is_stellar(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "stellar-desktop.exe" | "stellar-desktop"
    )
}

pub(super) fn workspace_valid(request: &AwarenessWorkspace) -> bool {
    request.version == 1
        && request.epoch.parse::<u64>().is_ok()
        && request.epoch.len() <= 20
        && request.panes.len() <= 8
        && request.panes.iter().all(|pane| {
            pane.title.chars().count() <= 80
                && !pane.title.chars().any(char::is_control)
                && matches!(
                    pane.surface.as_str(),
                    "rich-text"
                        | "image"
                        | "browser"
                        | "diagram"
                        | "chart"
                        | "workflow"
                        | "session"
                        | "assistant-message"
                        | "activity-summary"
                )
        })
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
