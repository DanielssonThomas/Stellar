use super::{
    contracts::{MicrophoneReviewError as Error, MicrophoneReviewOutcome as Outcome},
    policy::{self, ReviewToken},
};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use webview2_com::{
    CoTaskMemPWSTR,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        ICoreWebView2, ICoreWebView2_13, ICoreWebView2Profile4,
    },
    SetPermissionStateCompletedHandler,
};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::{
            Controls::{
                TASKDIALOG_BUTTON, TASKDIALOG_NOTIFICATIONS, TASKDIALOGCONFIG,
                TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER, TDF_POSITION_RELATIVE_TO_WINDOW,
                TDM_CLICK_BUTTON, TDN_TIMER, TaskDialogIndirect,
            },
            WindowsAndMessaging::{IDCANCEL, SendMessageW},
        },
    },
    core::{HRESULT, Interface, w},
};

struct DialogLifetime {
    token: ReviewToken,
    deadline: Instant,
}
impl DialogLifetime {
    fn current(&self) -> bool {
        self.token.current() && Instant::now() < self.deadline
    }
}

// SAFETY: TaskDialogIndirect invokes this only while the stack-owned DialogLifetime
// supplied in lpCallbackData remains alive. The callback retains no pointer or HWND.
unsafe extern "system" fn dialog_event(
    window: HWND,
    event: TASKDIALOG_NOTIFICATIONS,
    _: WPARAM,
    _: LPARAM,
    data: isize,
) -> HRESULT {
    if event == TDN_TIMER {
        // SAFETY: data is exactly the non-null pointer installed by confirm below;
        // TaskDialogIndirect is synchronous and its timer callbacks run on that UI thread.
        let lifetime = unsafe { &*(data as *const DialogLifetime) };
        if !lifetime.current() {
            // SAFETY: window is the live dialog delivered by Windows; only Cancel is sent.
            unsafe {
                SendMessageW(
                    window,
                    TDM_CLICK_BUTTON.0 as u32,
                    Some(WPARAM(IDCANCEL.0 as usize)),
                    None,
                );
            }
        }
    }
    HRESULT(0)
}

fn confirm(parent: HWND, lifetime: &DialogLifetime) -> Result<bool, Error> {
    let buttons = [
        TASKDIALOG_BUTTON {
            nButtonID: 100,
            pszButtonText: w!("Allow microphone"),
        },
        TASKDIALOG_BUTTON {
            nButtonID: IDCANCEL.0,
            pszButtonText: w!("Cancel"),
        },
    ];
    let config = TASKDIALOGCONFIG {
        cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: parent,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION
            | TDF_CALLBACK_TIMER
            | TDF_POSITION_RELATIVE_TO_WINDOW,
        pszWindowTitle: w!("Stellar microphone access"),
        pszMainInstruction: w!("Allow Stellar to use your microphone?"),
        pszContent: w!(
            "This saves microphone permission for Stellar. Windows privacy settings still apply. Listening will stay off until you enable the microphone in Stellar. Cancel leaves permission unchanged."
        ),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: IDCANCEL.0,
        pfCallback: Some(dialog_event),
        lpCallbackData: lifetime as *const DialogLifetime as isize,
        ..Default::default()
    };
    let mut selected = IDCANCEL.0;
    // SAFETY: config, literal UTF-16 strings, button array and lifetime are live
    // throughout this synchronous owned dialog. Windows writes only selected.
    unsafe { TaskDialogIndirect(&config, Some(&mut selected), None, None) }
        .map_err(|_| Error::Unavailable)?;
    Ok(selected == 100)
}

fn source_owned(view: &ICoreWebView2) -> Result<bool, Error> {
    let mut raw_source = windows::core::PWSTR::null();
    // SAFETY: WebView2 supplies an allocated string to a valid output pointer;
    // CoTaskMemPWSTR frees it on every path. The reference-counted view remains live.
    let result = unsafe { view.Source(&mut raw_source) };
    let source = CoTaskMemPWSTR::from(raw_source);
    result.map_err(|_| Error::Unavailable)?;
    Ok(tauri::Url::parse(&source.to_string()).is_ok_and(|url| policy::owned_origin(&url)))
}

pub async fn review(view: tauri::Webview, token: ReviewToken) -> Result<Outcome, Error> {
    let (send, receive) = oneshot::channel();
    view.with_webview(move |native| {
        let start = || -> Result<_, Error> {
            // SAFETY: with_webview runs on the controller's owning UI thread. All
            // COM interfaces stay here and drop before leaving this callback.
            let controller = native.controller();
            let core = unsafe { controller.CoreWebView2() }.map_err(|_| Error::Unavailable)?;
            if !source_owned(&core)? {
                return Err(Error::Forbidden);
            }
            let profile = core
                .cast::<ICoreWebView2_13>()
                .ok()
                .and_then(|core| unsafe { core.Profile() }.ok())
                .and_then(|profile| profile.cast::<ICoreWebView2Profile4>().ok());
            let mut parent = HWND::default();
            // SAFETY: valid output pointer and live controller, on its owner thread.
            unsafe { controller.ParentWindow(&mut parent) }.map_err(|_| Error::Unavailable)?;
            if parent.0.is_null() {
                return Err(Error::Unavailable);
            }
            let lifetime = DialogLifetime {
                token,
                deadline: Instant::now() + Duration::from_secs(120),
            };
            let choice = policy::consent(
                profile.is_some(),
                || lifetime.current(),
                || confirm(parent, &lifetime),
            )?;
            if choice == Outcome::Cancelled {
                return Ok(None);
            }
            if !lifetime.current() || !source_owned(&core)? {
                return Err(Error::Forbidden);
            }
            Ok(profile)
        };
        match start() {
            Ok(None) => {
                let _ = send.send(Ok(Outcome::Cancelled));
            }
            Err(error) => {
                let _ = send.send(Err(error));
            }
            Ok(Some(profile)) => {
                let complete =
                    SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                        let _ = send.send(
                            result
                                .map(|()| Outcome::Allowed)
                                .map_err(|_| Error::Unavailable),
                        );
                        Ok(())
                    }));
                // SAFETY: explicit native Allow was just selected; origin/lifetime
                // were rechecked. Only this fixed origin and MICROPHONE are passed.
                // WebView2 retains the completion handler; it owns only the sender.
                let _ = unsafe {
                    profile.SetPermissionState(
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                        w!("http://tauri.localhost"),
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                        &complete,
                    )
                };
            }
        }
    })
    .map_err(|_| Error::Unavailable)?;
    tokio::time::timeout(Duration::from_secs(130), receive)
        .await
        .map_err(|_| Error::Unavailable)?
        .map_err(|_| Error::Unavailable)?
}
