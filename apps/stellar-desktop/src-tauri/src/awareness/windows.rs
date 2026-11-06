use super::{contracts::*, state};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows_capture::window::Window;

pub(super) fn foreground() -> Result<AwarenessApp, ()> {
    let window = Window::foreground().map_err(|_| ())?;
    let process = window.process_id().map_err(|_| ())?;
    let app = state::label(&window.process_name().map_err(|_| ())?, 120);
    let title = state::label(&window.title().map_err(|_| ())?, 160);
    if !window.is_valid() || window.process_id().ok() != Some(process) || app.is_empty() {
        return Err(());
    }
    Ok(AwarenessApp {
        app,
        title,
        observed_at_ms: state::now().to_string(),
    })
}

fn wait<T: windows_core::RuntimeType>(
    operation: windows_future::IAsyncOperation<T>,
) -> Result<T, ()> {
    let start = Instant::now();
    while operation.Status().map_err(|_| ())? == windows_future::AsyncStatus::Started {
        if start.elapsed() >= Duration::from_millis(750) {
            let _ = operation.Cancel();
            return Err(());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    operation.GetResults().map_err(|_| ())
}

pub(super) struct Media {
    manager: Manager,
    session: Option<Session>,
    manager_token: i64,
    tokens: Option<(i64, i64)>,
    dirty: Arc<AtomicBool>,
    _apartment: Apartment,
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}

impl Media {
    pub fn new() -> Result<Self, ()> {
        wasapi::initialize_mta().ok().map_err(|_| ())?;
        Self::initialized(Apartment)
    }

    fn initialized(apartment: Apartment) -> Result<Self, ()> {
        let manager = wait(Manager::RequestAsync().map_err(|_| ())?)?;
        let dirty = Arc::new(AtomicBool::new(true));
        let notify = dirty.clone();
        let manager_token = manager
            .SessionsChanged(&windows::Foundation::TypedEventHandler::new(move |_, _| {
                notify.store(true, Ordering::Release);
                Ok(())
            }))
            .map_err(|_| ())?;
        Ok(Self {
            manager,
            session: None,
            manager_token,
            tokens: None,
            dirty,
            _apartment: apartment,
        })
    }

    pub fn changed(&self) -> bool {
        self.dirty.load(Ordering::Acquire)
    }

    pub fn snapshot(&mut self) -> Result<Option<AwarenessMedia>, ()> {
        self.dirty.store(false, Ordering::Release);
        let sessions = self.manager.GetSessions().map_err(|_| ())?;
        let mut selected = None;
        let count = sessions.Size().map_err(|_| ())?;
        if count > 64 {
            return Err(());
        }
        for index in 0..count {
            let session = sessions.GetAt(index).map_err(|_| ())?;
            let id = session
                .SourceAppUserModelId()
                .map_err(|_| ())?
                .to_string()
                .to_ascii_lowercase();
            if id == "spotify.exe" || id.starts_with("spotifyab.spotifymusic_") {
                if selected.is_some() {
                    return Err(());
                }
                selected = Some(session);
            }
        }
        if selected != self.session {
            self.subscribe(selected)?;
        }
        let Some(session) = &self.session else {
            return Ok(None);
        };
        let properties = wait(session.TryGetMediaPropertiesAsync().map_err(|_| ())?)?;
        let playing = session
            .GetPlaybackInfo()
            .map_err(|_| ())?
            .PlaybackStatus()
            .map_err(|_| ())?
            == Status::Playing;
        Ok(Some(AwarenessMedia {
            title: state::label(&properties.Title().map_err(|_| ())?.to_string(), 160),
            artist: state::label(&properties.Artist().map_err(|_| ())?.to_string(), 160),
            playing,
            observed_at_ms: state::now().to_string(),
        }))
    }

    fn subscribe(&mut self, session: Option<Session>) -> Result<(), ()> {
        self.unsubscribe();
        self.session = session;
        if let Some(session) = &self.session {
            let dirty = self.dirty.clone();
            let metadata = match session.MediaPropertiesChanged(
                &windows::Foundation::TypedEventHandler::new(move |_, _| {
                    dirty.store(true, Ordering::Release);
                    Ok(())
                }),
            ) {
                Ok(token) => token,
                Err(_) => {
                    self.session = None;
                    return Err(());
                }
            };
            let dirty = self.dirty.clone();
            match session.PlaybackInfoChanged(&windows::Foundation::TypedEventHandler::new(
                move |_, _| {
                    dirty.store(true, Ordering::Release);
                    Ok(())
                },
            )) {
                Ok(playback) => self.tokens = Some((metadata, playback)),
                Err(_) => {
                    let _ = session.RemoveMediaPropertiesChanged(metadata);
                    self.session = None;
                    return Err(());
                }
            }
        }
        Ok(())
    }

    fn unsubscribe(&mut self) {
        if let (Some(session), Some((metadata, playback))) = (&self.session, self.tokens.take()) {
            let _ = session.RemoveMediaPropertiesChanged(metadata);
            let _ = session.RemovePlaybackInfoChanged(playback);
        }
        self.session = None;
    }
}

impl Drop for Media {
    fn drop(&mut self) {
        self.unsubscribe();
        let _ = self.manager.RemoveSessionsChanged(self.manager_token);
    }
}
