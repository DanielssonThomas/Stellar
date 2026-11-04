#![allow(unsafe_code)]
use super::contracts::*;
use wasapi::{DeviceEnumerator, Direction};
use windows::Win32::{Media::Audio::Endpoints::IAudioEndpointVolume, System::Com::CLSCTX_ALL};

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
