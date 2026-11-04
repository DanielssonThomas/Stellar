use super::contracts::IvyErrorCode;
use super::workspace_contracts::{WorkspaceDisplay, WorkspaceToolOperation};

pub enum Captured {
    Image(Vec<u8>),
    Displays(Vec<WorkspaceDisplay>),
}

pub fn is_image(operation: &WorkspaceToolOperation) -> bool {
    matches!(
        operation,
        WorkspaceToolOperation::CaptureWindow
            | WorkspaceToolOperation::CaptureDisplay { .. }
            | WorkspaceToolOperation::CaptureForeground
    )
}

pub fn is_native(operation: &WorkspaceToolOperation) -> bool {
    is_image(operation) || matches!(operation, WorkspaceToolOperation::ListDisplays)
}

const MAX_DIMENSION: u32 = 8192;
pub const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
#[cfg(windows)]
#[derive(Clone, Copy)]
enum Encoding {
    OwnedWindow,
    Screen,
}
#[path = "workspace_capture_image.rs"]
mod image;

fn dimensions(width: u32, height: u32, stride: usize, size: usize) -> bool {
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > 36_000_000
    {
        return false;
    }
    let Some(row) = (width as usize).checked_mul(4) else {
        return false;
    };
    let Some(total) = stride.checked_mul(height as usize) else {
        return false;
    };
    stride >= row && total <= size
}

#[cfg(windows)]
mod platform {
    use super::{
        Encoding, IvyErrorCode, MAX_DIMENSION, MAX_IMAGE_BYTES, dimensions,
        image::encode as encode_pixels,
    };
    use std::{sync::mpsc, time::Duration};
    use tauri::{AppHandle, Manager};
    use windows_capture::{
        capture::{Context, GraphicsCaptureApiHandler},
        encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat},
        frame::Frame,
        graphics_capture_api::InternalCaptureControl,
        settings::{
            ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
            MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
        },
        window::Window,
    };

    type CaptureResult = Result<Vec<u8>, IvyErrorCode>;
    struct Capture {
        reply: mpsc::SyncSender<CaptureResult>,
        encoding: Encoding,
    }
    impl GraphicsCaptureApiHandler for Capture {
        type Flags = (mpsc::SyncSender<CaptureResult>, Encoding);
        type Error = Box<dyn std::error::Error + Send + Sync>;

        fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self {
                reply: context.flags.0,
                encoding: context.flags.1,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            let result = encode(frame, self.encoding);
            let _ = self.reply.try_send(result);
            control.stop();
            Ok(())
        }
    }

    fn encode(frame: &mut Frame, encoding: Encoding) -> CaptureResult {
        let width = frame.width();
        let height = frame.height();
        if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
            return Err(IvyErrorCode::Unavailable);
        }
        let mut buffer = frame.buffer().map_err(|_| IvyErrorCode::Unavailable)?;
        let stride = buffer.row_pitch() as usize;
        let raw = buffer.as_raw_buffer();
        if !dimensions(width, height, stride, raw.len()) {
            return Err(IvyErrorCode::Unavailable);
        }
        let row = width as usize * 4;
        let mut pixels = Vec::with_capacity(row * height as usize);
        for offset in (0..height as usize).map(|y| y * stride) {
            pixels.extend_from_slice(&raw[offset..offset + row]);
        }
        match encoding {
            Encoding::Screen => encode_pixels(pixels, width, height),
            Encoding::OwnedWindow => {
                let bytes = ImageEncoder::new(ImageFormat::Png, ImageEncoderPixelFormat::Rgba8)
                    .and_then(|encoder| encoder.encode(&pixels, width, height))
                    .map_err(|_| IvyErrorCode::Unavailable)?;
                if bytes.len() > MAX_IMAGE_BYTES {
                    return Err(IvyErrorCode::Unavailable);
                }
                Ok(bytes)
            }
        }
    }

    pub fn capture(app: &AppHandle) -> CaptureResult {
        let main = app.get_window("main").ok_or(IvyErrorCode::Unavailable)?;
        let hwnd = main.hwnd().map_err(|_| IvyErrorCode::Unavailable)?;
        let window = Window::from_raw_hwnd(hwnd.0.cast());
        if !window.is_valid()
            || window.process_id().map_err(|_| IvyErrorCode::Unavailable)? != std::process::id()
        {
            return Err(IvyErrorCode::Unavailable);
        }
        let width = window.width().map_err(|_| IvyErrorCode::Unavailable)?;
        let height = window.height().map_err(|_| IvyErrorCode::Unavailable)?;
        if width <= 0 || height <= 0 || width > 4096 || height > 4096 {
            return Err(IvyErrorCode::Unavailable);
        }
        let image = capture_item(window, Encoding::OwnedWindow)?;
        let current = app
            .get_window("main")
            .ok_or(IvyErrorCode::Unavailable)?
            .hwnd()
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if current.0 != hwnd.0
            || !window.is_valid()
            || window.process_id().map_err(|_| IvyErrorCode::Unavailable)? != std::process::id()
        {
            return Err(IvyErrorCode::Unavailable);
        }
        Ok(image)
    }

    pub(super) fn capture_item<
        T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Send + 'static,
    >(
        target: T,
        encoding: Encoding,
    ) -> CaptureResult {
        let (sender, receiver) = mpsc::sync_channel(1);
        let settings = Settings::new(
            target,
            CursorCaptureSettings::WithoutCursor,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Exclude,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            (sender, encoding),
        );
        let control =
            Capture::start_free_threaded(settings).map_err(|_| IvyErrorCode::Unavailable)?;
        let result = receiver
            .recv_timeout(Duration::from_secs(8))
            .map_err(|_| IvyErrorCode::Timeout);
        control.stop().map_err(|_| IvyErrorCode::Unavailable)?;
        result?
    }
}

#[cfg(windows)]
pub use platform::capture;

#[cfg(windows)]
#[path = "workspace_screens.rs"]
mod screens;

#[cfg(windows)]
pub fn capture_operation(
    app: &tauri::AppHandle,
    operation: &WorkspaceToolOperation,
) -> Result<Captured, IvyErrorCode> {
    match operation {
        WorkspaceToolOperation::CaptureWindow => capture(app).map(Captured::Image),
        WorkspaceToolOperation::ListDisplays => screens::list().map(Captured::Displays),
        WorkspaceToolOperation::CaptureDisplay { display_id } => {
            screens::display(display_id.as_deref()).map(Captured::Image)
        }
        WorkspaceToolOperation::CaptureForeground => screens::foreground().map(Captured::Image),
        _ => Err(IvyErrorCode::MalformedRequest),
    }
}

#[cfg(test)]
mod tests {
    use super::dimensions;

    #[test]
    fn rejects_bad_dimensions_stride_and_truncated_frames() {
        assert!(dimensions(4, 3, 20, 60));
        assert!(!dimensions(0, 3, 20, 60));
        assert!(dimensions(4097, 3, 20000, 60000));
        assert!(!dimensions(8193, 1, 40000, 40000));
        assert!(!dimensions(8192, 8192, 32768, 268435456));
        assert!(!dimensions(4, 3, 15, 60));
        assert!(!dimensions(4, 3, 20, 59));
        assert!(!dimensions(4, 2, usize::MAX, usize::MAX));
    }
}
