#![allow(unsafe_code)]
use super::contracts::*;
use std::rc::Rc;
use wasapi::{DeviceEnumerator, Direction};
use windows::Win32::{
    Media::Audio::{
        AudioSessionStateExpired, Endpoints::IAudioEndpointVolume, IAudioSessionControl2,
        IAudioSessionManager2, ISimpleAudioVolume,
    },
    System::Com::{CLSCTX_ALL, CoTaskMemFree},
};
use windows_core::Interface;

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}

struct DuckSession {
    volume: ISimpleAudioVolume,
    control: IAudioSessionControl2,
    // Drop the interface before releasing this thread's COM apartment.
    _apartment: Rc<Apartment>,
}

pub(crate) fn duck_sessions() -> Result<Vec<crate::volume_ducking::Session>, ()> {
    wasapi::initialize_mta().ok().map_err(|_| ())?;
    let apartment = Rc::new(Apartment);
    let devices = DeviceEnumerator::new()
        .map_err(|_| ())?
        .get_device_collection(&Direction::Render)
        .map_err(|_| ())?;
    let mut sessions = Vec::new();
    for device in &devices {
        let Ok(device) = device else {
            continue;
        };
        let Ok(id) = device.get_id() else {
            continue;
        };
        // Interfaces stay on this MTA; every COM allocation is freed after copying.
        let Ok(manager) = (unsafe {
            device
                .as_immdevice()
                .Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
        }) else {
            continue;
        };
        let Ok(enumerator) = (unsafe { manager.GetSessionEnumerator() }) else {
            continue;
        };
        let Ok(count) = (unsafe { enumerator.GetCount() }) else {
            continue;
        };
        for index in 0..count.min(256) {
            if sessions.len() >= 256 {
                break;
            }
            let Ok(control) = (unsafe { enumerator.GetSession(index) })
                .and_then(|c| c.cast::<IAudioSessionControl2>())
            else {
                continue;
            };
            let mut process = 0;
            let ownership = unsafe {
                (Interface::vtable(&control).GetProcessId)(
                    Interface::as_raw(&control),
                    &mut process,
                )
            };
            if ownership.0 != 0 && unsafe { control.IsSystemSoundsSession() }.0 != 0 {
                continue;
            }
            // Unknown cross-process ownership cannot safely exclude Ivy.
            if process == 0 && unsafe { control.IsSystemSoundsSession() }.0 != 0 {
                continue;
            }
            let Ok(raw) = (unsafe { control.GetSessionInstanceIdentifier() }) else {
                continue;
            };
            let instance = unsafe { raw.to_string() };
            unsafe { CoTaskMemFree(Some(raw.0.cast())) };
            let Ok(instance) = instance else {
                continue;
            };
            let Ok(volume) = control.cast::<ISimpleAudioVolume>() else {
                continue;
            };
            sessions.push(crate::volume_ducking::Session {
                id: format!("{id}/{instance}"),
                process,
                endpoint: Box::new(DuckSession {
                    volume,
                    control,
                    _apartment: apartment.clone(),
                }),
            });
        }
    }
    Ok(sessions)
}

impl crate::volume_ducking::Endpoint for DuckSession {
    fn read(&self) -> Result<f32, ()> {
        // The owned interface and MTA stay alive on the worker thread.
        unsafe { self.volume.GetMasterVolume() }.map_err(|_| ())
    }

    fn write(&self, level: f32) -> Result<(), ()> {
        if !level.is_finite() || !(0.0..=1.0).contains(&level) {
            return Err(());
        }
        // The optional event-context GUID is null; mute is never changed.
        unsafe { self.volume.SetMasterVolume(level, std::ptr::null()) }.map_err(|_| ())
    }

    fn is_current(&self) -> bool {
        unsafe { self.control.GetState() }.is_ok_and(|state| state != AudioSessionStateExpired)
    }
}

fn endpoint() -> Result<(IAudioEndpointVolume, String), ()> {
    let device = DeviceEnumerator::new()
        .map_err(|_| ())?
        .get_default_device(&Direction::Render)
        .map_err(|_| ())?;
    let id = device.get_id().map_err(|_| ())?;
    // Called only inside an initialized MTA. Activate owns the returned COM reference;
    // no pointers escape, and no capture device or audio stream is opened.
    let volume = unsafe {
        device
            .as_immdevice()
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
    }
    .map_err(|_| ())?;
    Ok((volume, id))
}

pub fn read() -> Result<(u8, bool, String), ()> {
    let (volume, id) = endpoint()?;
    // Both getters return owned scalar values through windows-rs checked results.
    let (level, muted) = unsafe { (volume.GetMasterVolumeLevelScalar(), volume.GetMute()) };
    Ok((
        (level.map_err(|_| ())?.clamp(0.0, 1.0) * 100.0).round() as u8,
        muted.map_err(|_| ())?.as_bool(),
        id,
    ))
}

pub fn change(
    action: &ReflexMediaAction,
    expected: &ReflexMediaState,
    commit: &super::media_host::Commit<'_>,
) -> ReflexMediaResult {
    let Ok((before, muted, id)) = read() else {
        return ReflexMediaResult::Rejected;
    };
    if Some(before) != expected.volume
        || Some(muted) != expected.muted
        || Some(&id) != expected.endpoint_id.as_ref()
    {
        return ReflexMediaResult::Rejected;
    }
    let Ok((volume, current_id)) = endpoint() else {
        return ReflexMediaResult::Rejected;
    };
    if id != current_id {
        return ReflexMediaResult::Rejected;
    }
    use ReflexMediaAction::*;
    let target = match action {
        VolumeUp => before.saturating_add(10).min(100),
        VolumeDown => before.saturating_sub(10),
        _ => before,
    };
    let target_mute = match action {
        Mute => true,
        Unmute => false,
        _ => muted,
    };
    // null is the documented optional event-context GUID. The endpoint remains alive
    // throughout each call; changes are bounded, and success requires readback.
    let mut result = None;
    if !commit(&mut || {
        result = Some(unsafe {
            match action {
                VolumeUp | VolumeDown => {
                    volume.SetMasterVolumeLevelScalar(target as f32 / 100.0, std::ptr::null())
                }
                Mute | Unmute => volume.SetMute(target_mute, std::ptr::null()),
                _ => unreachable!(),
            }
        })
    }) {
        return ReflexMediaResult::Rejected;
    }
    if result.is_none_or(|r| r.is_err()) {
        return ReflexMediaResult::Uncertain;
    }
    match read() {
        Ok((level, muted, after_id))
            if after_id == id && level == target && muted == target_mute =>
        {
            ReflexMediaResult::Confirmed
        }
        _ => ReflexMediaResult::Uncertain,
    }
}
