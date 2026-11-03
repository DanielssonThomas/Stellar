use super::contracts::IvyErrorCode;

const MAX_DIMENSION: u32 = 4096;
pub const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;

fn dimensions(width: u32, height: u32, stride: usize, size: usize) -> bool {
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
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
    use super::{IvyErrorCode, MAX_DIMENSION, MAX_IMAGE_BYTES, dimensions};
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
    }
    impl GraphicsCaptureApiHandler for Capture {
        type Flags = mpsc::SyncSender<CaptureResult>;
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
            let result = encode(frame);
            let _ = self.reply.try_send(result);
            control.stop();
            Ok(())
        }
    }

    fn encode(frame: &mut Frame) -> CaptureResult {
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
        let bytes = ImageEncoder::new(ImageFormat::Png, ImageEncoderPixelFormat::Rgba8)
            .and_then(|encoder| encoder.encode(&pixels, width, height))
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(IvyErrorCode::Unavailable);
        }
        Ok(bytes)
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
        if width <= 0
            || height <= 0
            || width > MAX_DIMENSION as i32
            || height > MAX_DIMENSION as i32
        {
            return Err(IvyErrorCode::Unavailable);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let settings = Settings::new(
            window,
            CursorCaptureSettings::WithoutCursor,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Exclude,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            sender,
        );
        let control =
            Capture::start_free_threaded(settings).map_err(|_| IvyErrorCode::Unavailable)?;
        let result = receiver
            .recv_timeout(Duration::from_secs(8))
            .map_err(|_| IvyErrorCode::Timeout);
        control.stop().map_err(|_| IvyErrorCode::Unavailable)?;
        let image = result??;
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
}

#[cfg(windows)]
pub use platform::capture;

#[cfg(test)]
mod tests {
    use super::dimensions;

    #[test]
    fn rejects_bad_dimensions_stride_and_truncated_frames() {
        assert!(dimensions(4, 3, 20, 60));
        assert!(!dimensions(0, 3, 20, 60));
        assert!(!dimensions(4097, 3, 20000, 60000));
        assert!(!dimensions(4, 3, 15, 60));
        assert!(!dimensions(4, 3, 20, 59));
        assert!(!dimensions(4, 2, usize::MAX, usize::MAX));
    }
}
