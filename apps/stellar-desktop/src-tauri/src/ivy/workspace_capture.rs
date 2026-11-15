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
#[path = "workspace_capture_diagnostics.rs"]
mod diagnostics;
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
    use super::diagnostics::{self, Stage, record, unavailable};
    use super::{IvyErrorCode, MAX_DIMENSION, dimensions, image::encode as encode_pixels};
    use std::{sync::mpsc, time::Duration};
    use tauri::{AppHandle, Manager};
    use windows_capture::{
        capture::{Context, GraphicsCaptureApiHandler},
        frame::Frame,
        graphics_capture_api::InternalCaptureControl,
        settings::{
            ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
            MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
        },
        window::Window,
    };

    struct Pixels {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
    }
    type FrameResult = Result<Pixels, IvyErrorCode>;
    type CaptureResult = Result<Vec<u8>, IvyErrorCode>;
    struct Capture {
        reply: mpsc::SyncSender<FrameResult>,
    }
    impl GraphicsCaptureApiHandler for Capture {
        type Flags = mpsc::SyncSender<FrameResult>;
        type Error = Box<dyn std::error::Error + Send + Sync>;

        fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self {
                reply: context.flags,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            record(Stage::Frame, 0, None);
            let result = pixels(frame);
            let _ = self.reply.try_send(result);
            control.stop();
            Ok(())
        }
    }

    fn pixels(frame: &mut Frame) -> FrameResult {
        let width = frame.width();
        let height = frame.height();
        if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
            return Err(unavailable(Stage::FrameBounds));
        }
        let mut buffer = frame.buffer().map_err(|_| unavailable(Stage::Buffer))?;
        let stride = buffer.row_pitch() as usize;
        let raw = buffer.as_raw_buffer();
        if !dimensions(width, height, stride, raw.len()) {
            return Err(unavailable(Stage::BufferBounds));
        }
        let row = width as usize * 4;
        let mut pixels = Vec::with_capacity(row * height as usize);
        for offset in (0..height as usize).map(|y| y * stride) {
            pixels.extend_from_slice(&raw[offset..offset + row]);
        }
        Ok(Pixels {
            bytes: pixels,
            width,
            height,
        })
    }

    pub fn capture(app: &AppHandle) -> CaptureResult {
        record(Stage::Enter, 0, None);
        let main = app
            .get_window("main")
            .ok_or_else(|| unavailable(Stage::WindowLookup))?;
        let hwnd = main.hwnd().map_err(|_| unavailable(Stage::WindowHandle))?;
        let window = Window::from_raw_hwnd(hwnd.0.cast());
        if !window.is_valid()
            || window
                .process_id()
                .map_err(|_| unavailable(Stage::WindowProcess))?
                != std::process::id()
        {
            return Err(unavailable(Stage::WindowOwner));
        }
        record(Stage::WindowValidity, 0, None);
        let width = window
            .width()
            .map_err(|_| unavailable(Stage::WindowWidth))?;
        let height = window
            .height()
            .map_err(|_| unavailable(Stage::WindowHeight))?;
        if width <= 0
            || height <= 0
            || width > MAX_DIMENSION as i32
            || height > MAX_DIMENSION as i32
        {
            return Err(unavailable(Stage::WindowBounds));
        }
        let image = capture_item(window)?;
        let current = app
            .get_window("main")
            .ok_or_else(|| unavailable(Stage::RecheckLookup))?
            .hwnd()
            .map_err(|_| unavailable(Stage::RecheckHandle))?;
        if current.0 != hwnd.0
            || !window.is_valid()
            || window
                .process_id()
                .map_err(|_| unavailable(Stage::RecheckProcess))?
                != std::process::id()
        {
            return Err(unavailable(Stage::RecheckOwner));
        }
        record(Stage::Complete, 0, None);
        Ok(image)
    }

    pub(super) fn capture_item<
        T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Send + 'static,
    >(
        target: T,
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
            sender,
        );
        record(Stage::Start, 0, None);
        let control = Capture::start_free_threaded(settings).map_err(|error| {
            let (class, os) = diagnostics::pipeline(&error);
            record(Stage::Start, class, os);
            IvyErrorCode::Unavailable
        })?;
        record(Stage::Started, 0, None);
        let result = receiver
            .recv_timeout(Duration::from_secs(8))
            .map_err(|error| {
                record(
                    Stage::Wait,
                    match error {
                        mpsc::RecvTimeoutError::Timeout => 400,
                        mpsc::RecvTimeoutError::Disconnected => 401,
                    },
                    None,
                );
                IvyErrorCode::Timeout
            });
        record(Stage::Stop, 0, None);
        control.stop().map_err(|error| {
            let (class, os) = diagnostics::stop(&error);
            record(Stage::Stop, class, os);
            IvyErrorCode::Unavailable
        })?;
        record(Stage::Stopped, 0, None);
        let frame = result??;
        // Release Windows capture before bounded CPU encoding; the frame deadline covers acquisition.
        record(Stage::Encode, 0, None);
        let image = encode_pixels(frame.bytes, frame.width, frame.height)
            .inspect_err(|_| record(Stage::Encode, 1, None))?;
        record(Stage::Encoded, 0, None);
        Ok(image)
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
