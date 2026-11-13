use super::IvyErrorCode;
use windows_capture::{
    capture::{CaptureControlError, GraphicsCaptureApiError},
    graphics_capture_api::Error,
};

#[derive(Clone, Copy, Debug)]
pub(super) enum Stage {
    Enter,
    WindowLookup,
    WindowHandle,
    WindowValidity,
    WindowProcess,
    WindowOwner,
    WindowWidth,
    WindowHeight,
    WindowBounds,
    Start,
    Started,
    Frame,
    FrameBounds,
    Buffer,
    BufferBounds,
    Wait,
    Stop,
    Stopped,
    Encode,
    Encoded,
    RecheckLookup,
    RecheckHandle,
    RecheckProcess,
    RecheckOwner,
    Complete,
}

// Only closed stages and numeric classes/codes cross this diagnostic boundary.
// Never format dependency errors: they may carry paths or other private data.
pub(super) fn record(stage: Stage, class: u16, os: Option<i32>) {
    #[cfg(feature = "native-smoke")]
    {
        use std::io::Write;
        let _ = writeln!(std::io::stdout().lock(), "{}", line(stage, class, os));
    }
    #[cfg(not(feature = "native-smoke"))]
    let _ = (stage, class, os);
}

#[cfg(any(feature = "native-smoke", test))]
fn line(stage: Stage, class: u16, os: Option<i32>) -> String {
    format!("STELLAR_SMOKE_STAGE capture-stage={stage:?} class={class} os={os:?}")
}

pub(super) fn unavailable(stage: Stage) -> IvyErrorCode {
    record(stage, 1, None);
    IvyErrorCode::Unavailable
}

pub(super) fn pipeline<E>(error: &GraphicsCaptureApiError<E>) -> (u16, Option<i32>) {
    use self::GraphicsCaptureApiError::*;
    let class = match error {
        FailedToJoinThread => 100,
        FailedToInitWinRT => 101,
        FailedToCreateDispatcherQueueController => 102,
        FailedToShutdownDispatcherQueue => 103,
        FailedToSetDispatcherQueueCompletedHandler => 104,
        FailedToRunMessageLoop => 105,
        FailedToStartCaptureThread => 106,
        ItemConvertFailed => 107,
        DirectXError(_) => 108,
        NewHandlerError(_) => 109,
        FrameHandlerError(_) => 110,
        GraphicsCaptureApiError(error) => return graphics(error),
    };
    (class, None)
}

fn graphics(error: &Error) -> (u16, Option<i32>) {
    let class = match error {
        Error::Unsupported => 200,
        Error::CursorConfigUnsupported => 201,
        Error::BorderConfigUnsupported => 202,
        Error::SecondaryWindowsUnsupported => 203,
        Error::MinimumUpdateIntervalUnsupported => 204,
        Error::DirtyRegionUnsupported => 205,
        Error::AlreadyStarted => 206,
        Error::DirectXError(_) => 207,
        Error::WindowError(_) => 208,
        Error::WindowsError(error) => return (209, Some(error.code().0)),
    };
    (class, None)
}

pub(super) fn stop<E>(error: &CaptureControlError<E>) -> (u16, Option<i32>) {
    use CaptureControlError::*;
    let class = match error {
        FailedToJoinThread => 300,
        ThreadHandleIsTaken => 301,
        FailedToPostThreadMessage => 302,
        StoppedHandlerError(_) => 303,
        GraphicsCaptureApiError(error) => return pipeline(error),
    };
    (class, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_nested_pipeline_class_without_dependency_error_text() {
        let error = GraphicsCaptureApiError::NewHandlerError("private-window-title-and-path");
        let (class, os) = pipeline(&error);
        let record = line(Stage::Start, class, os);
        assert_eq!(
            record,
            "STELLAR_SMOKE_STAGE capture-stage=Start class=109 os=None"
        );
        let error = CaptureControlError::<()>::GraphicsCaptureApiError(
            GraphicsCaptureApiError::GraphicsCaptureApiError(Error::SecondaryWindowsUnsupported),
        );
        assert_eq!(stop(&error), (203, None));
        assert_eq!(
            stop(&CaptureControlError::<()>::FailedToPostThreadMessage),
            (302, None)
        );
    }
}
