use super::{contracts::*, media_host::MediaPort};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};

pub struct WindowsMedia;

fn session() -> Option<Session> {
    wait(Manager::RequestAsync().ok()?, &|| true)?
        .GetCurrentSession()
        .ok()
}

fn wait<T: windows_core::RuntimeType>(
    operation: windows_future::IAsyncOperation<T>,
    current: &dyn Fn() -> bool,
) -> Option<T> {
    let start = std::time::Instant::now();
    while operation.Status().ok()? == windows_future::AsyncStatus::Started {
        if !current() || start.elapsed() > std::time::Duration::from_secs(1) {
            let _ = operation.Cancel();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    operation.GetResults().ok()
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self, ()> {
        wasapi::initialize_mta().ok().map_err(|_| ())?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}

impl MediaPort for WindowsMedia {
    fn snapshot(&self) -> Result<ReflexMediaState, ()> {
        let _apartment = Apartment::new()?;
        let mut result = ReflexMediaState {
            ticket: String::new(),
            player: None,
            title: None,
            playing: false,
            volume: None,
            muted: None,
            endpoint_id: None,
            actions: vec!["inspect".into()],
        };
        if let Some(s) = session() {
            result.player = s.SourceAppUserModelId().ok().map(|v| v.to_string());
            result.title = s
                .TryGetMediaPropertiesAsync()
                .ok()
                .and_then(|a| wait(a, &|| true))
                .and_then(|p| p.Title().ok())
                .map(|v| v.to_string());
            if let Ok(info) = s.GetPlaybackInfo() {
                result.playing = info.PlaybackStatus().ok() == Some(Status::Playing);
                if let Ok(c) = info.Controls() {
                    for (enabled, name) in [
                        (c.IsPlayEnabled(), "play"),
                        (c.IsPauseEnabled(), "pause"),
                        (c.IsNextEnabled(), "next"),
                        (c.IsPreviousEnabled(), "previous"),
                    ] {
                        if enabled.unwrap_or(false) {
                            result.actions.push(name.into());
                        }
                    }
                }
            }
        }
        if let Ok((volume, muted, endpoint)) = super::windows_volume::read() {
            result.volume = Some(volume);
            result.muted = Some(muted);
            result.endpoint_id = Some(endpoint);
            result
                .actions
                .extend(["volume_up", "volume_down", "mute", "unmute"].map(String::from));
        }
        // Do not expose unbounded player metadata to either model or renderer.
        result.player = result.player.map(|v| v.chars().take(240).collect());
        result.title = result.title.map(|v| v.chars().take(240).collect());
        Ok(result)
    }

    fn execute(
        &self,
        action: &ReflexMediaAction,
        expected: &ReflexMediaState,
        commit: &super::media_host::Commit<'_>,
    ) -> ReflexMediaResult {
        let Ok(_apartment) = Apartment::new() else {
            return ReflexMediaResult::Rejected;
        };
        let name = serde_json::to_value(action)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        if !expected.actions.contains(&name) {
            return ReflexMediaResult::Rejected;
        }
        use ReflexMediaAction::*;
        let result = match action {
            Inspect => return ReflexMediaResult::Confirmed,
            VolumeUp | VolumeDown | Mute | Unmute => {
                return super::windows_volume::change(action, expected, commit);
            }
            _ => session().and_then(|s| {
                if s.SourceAppUserModelId().ok().map(|v| v.to_string()) != expected.player {
                    return None;
                }
                let mut operation = None;
                if !commit(&mut || {
                    operation = Some(match action {
                        Play => s.TryPlayAsync(),
                        Pause => s.TryPauseAsync(),
                        Next => s.TrySkipNextAsync(),
                        Previous => s.TrySkipPreviousAsync(),
                        _ => unreachable!(),
                    })
                }) {
                    return Some(false);
                }
                operation?.ok().and_then(|a| wait(a, &|| true))
            }),
        };
        match result {
            Some(true) => ReflexMediaResult::Confirmed,
            Some(false) => ReflexMediaResult::Rejected,
            None => ReflexMediaResult::Uncertain,
        }
    }
}
