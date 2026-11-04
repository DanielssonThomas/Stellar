use super::{IvyErrorCode, WorkspaceDisplay, platform::capture_item};
use windows_capture::{monitor::Monitor, window::Window};

fn monitors() -> Result<Vec<Monitor>, IvyErrorCode> {
    let monitors = Monitor::enumerate().map_err(|_| IvyErrorCode::Unavailable)?;
    if monitors.is_empty() || monitors.len() > 16 {
        return Err(IvyErrorCode::Unavailable);
    }
    Ok(monitors)
}

pub(super) fn list() -> Result<Vec<WorkspaceDisplay>, IvyErrorCode> {
    let primary = Monitor::primary().ok();
    let foreground = Window::foreground()
        .ok()
        .and_then(|window| window.monitor());
    monitors()?
        .into_iter()
        .map(|monitor| {
            let id = monitor
                .device_name()
                .map_err(|_| IvyErrorCode::Unavailable)?;
            if !super::super::workspace_validate::display_id_valid(&id) {
                return Err(IvyErrorCode::Unavailable);
            }
            Ok(WorkspaceDisplay {
                id,
                name: monitor
                    .name()
                    .unwrap_or_else(|_| "Display".into())
                    .chars()
                    .take(240)
                    .collect(),
                width: monitor.width().map_err(|_| IvyErrorCode::Unavailable)?,
                height: monitor.height().map_err(|_| IvyErrorCode::Unavailable)?,
                primary: Some(monitor) == primary,
                foreground: Some(monitor) == foreground,
            })
        })
        .collect()
}

pub(super) fn display(id: Option<&str>) -> Result<Vec<u8>, IvyErrorCode> {
    let metadata = list()?;
    let selected = select(&metadata, id).ok_or(IvyErrorCode::Unavailable)?;
    let available = monitors()?;
    let target = available
        .into_iter()
        .find(|monitor| monitor.device_name().is_ok_and(|name| name == selected.id))
        .ok_or(IvyErrorCode::Unavailable)?;
    capture_item(target)
}

fn select<'a>(
    displays: &'a [WorkspaceDisplay],
    requested: Option<&str>,
) -> Option<&'a WorkspaceDisplay> {
    if let Some(id) = requested {
        return displays.iter().find(|display| display.id == id);
    }
    displays
        .iter()
        .find(|display| display.foreground)
        .or_else(|| displays.iter().find(|display| display.primary))
}

#[cfg(test)]
#[path = "workspace_screens_tests.rs"]
mod tests;

pub(super) fn foreground() -> Result<Vec<u8>, IvyErrorCode> {
    let target = Window::foreground().map_err(|_| IvyErrorCode::Unavailable)?;
    let owner = target.process_id().map_err(|_| IvyErrorCode::Unavailable)?;
    if !target.is_valid() {
        return Err(IvyErrorCode::Unavailable);
    }
    let image = capture_item(target)?;
    if !target.is_valid() || target.process_id().ok() != Some(owner) {
        return Err(IvyErrorCode::Unavailable);
    }
    Ok(image)
}
