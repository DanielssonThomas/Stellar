use tauri::{Manager, Webview, Wry};

#[tauri::command]
fn smoke_result(app: tauri::AppHandle, success: bool) {
    if success {
        println!("STELLAR_NATIVE_SMOKE_OK");
    }
    app.exit(if success { 0 } else { 1 });
}

#[tauri::command]
fn smoke_hold_ivy(
    host: tauri::State<'_, crate::ivy::IvyHost>,
) -> Result<(), crate::ivy::contracts::IvyErrorCode> {
    host.smoke_hold()
}

#[cfg(windows)]
#[tauri::command]
async fn smoke_capture_window(app: tauri::AppHandle) -> bool {
    tauri::async_runtime::spawn_blocking(move || crate::ivy::capture_workspace_window(&app))
        .await
        .is_ok_and(|result| {
            result.is_ok_and(|image| {
                image.starts_with(b"\x89PNG\r\n\x1a\n") && image.len() <= 4 * 1024 * 1024
            })
        })
}

fn check_page(window: Webview) {
    let script = r#"
        (async () => {
            const invoke = window.__TAURI__.core.invoke;
            try {
                for (let n = 0; n < 100 && !(document.querySelector('stellar-root')?.getAttribute('data-desktop-ready') === 'true' &&
                    document.querySelector('stellar-root')?.getAttribute('data-desktop-event') === 'true'); n++)
                    await new Promise(resolve => setTimeout(resolve, 100));
                let telemetryOk = false;
                try { const snapshot = await invoke('telemetry_snapshot'); telemetryOk = snapshot.schemaVersion === 1; }
                catch (error) { telemetryOk = !__TELEMETRY_EXPECT_LIVE__ && ['unavailable', 'timeout', 'invalid'].includes(error); }
                const reply = await invoke('shell_status', { request: { version: 1 } });
                let rejected = false;
                try { await invoke('shell_status', { request: { version: 2 } }); }
                catch (error) { rejected = error.code === 'unsupported_version' && error.received === 2; }
                let malformedRejected = false;
                try { await invoke('app_info', { request: { version: '1', sequence: '0' } }); }
                catch (error) { malformedRejected = error.code === 'malformed_request'; }
                const selected = await invoke('ivy_select_session', { request: { version: 1, model: 'sol' } });
                const cleared = await invoke('ivy_clear_conversation', { request: { version: 1 } });
                const sessionsOk = selected.model === 'sol' && selected.verified_model === null &&
                    cleared.model === 'terra' && cleared.verified_model === null && cleared.turn === 'idle' && cleared.turn_id === null;
                await invoke('smoke_hold_ivy');
                const pending = invoke('ivy_select_session', { request: { version: 1, model: 'sol' } }).then(() => false, () => true);
                await new Promise(resolve => setTimeout(resolve, 100));
                let snapshotBusy = false;
                try { await invoke('ivy_snapshot', { request: { version: 1 } }); }
                catch (error) { snapshotBusy = error === 'busy'; }
                const beforeDisconnect = performance.now();
                await invoke('ivy_disconnect', { request: { version: 1 } });
                const disconnectResponsive = performance.now() - beforeDisconnect < 750;
                const cancelledRotation = await pending;
                const capturedWindow = await invoke('smoke_capture_window');
                const rendered = document.querySelector('h1')?.textContent?.includes('Stellar Desktop');
                const root = document.querySelector('stellar-root');
                const adapterReady = root?.getAttribute('data-desktop-ready') === 'true' &&
                    root?.getAttribute('data-desktop-event') === 'true' &&
                    root?.getAttribute('data-desktop-capabilities') === 'Native window controls, Contract notifications';
                const rootStyle = getComputedStyle(document.querySelector('stellar-root'));
                const main = document.querySelector('main');
                const template = main?.querySelector('stellar-desktop-experience-template');
                const experience = template?.querySelector('.experience');
                const fillsViewport = (element, display = 'block') => {
                    if (!element) return false;
                    const style = getComputedStyle(element);
                    const bounds = element.getBoundingClientRect();
                    return style.display === display && style.visibility === 'visible' &&
                        Math.abs(bounds.x) <= 1 && Math.abs(bounds.y) <= 1 &&
                        Math.abs(bounds.width - window.innerWidth) <= 1 &&
                        Math.abs(bounds.height - window.innerHeight) <= 1 &&
                        Math.abs(parseFloat(style.height) - window.innerHeight) <= 1;
                };
                const nonce = document.querySelector('#stellar-csp-anchor')?.nonce;
                const componentStyles = [...document.querySelectorAll('style')].filter(style =>
                    style.id !== 'stellar-csp-anchor' && style.textContent.includes('_nghost'));
                const styled = rootStyle.display === 'block' && fillsViewport(main) && fillsViewport(template) &&
                    fillsViewport(experience, 'grid') &&
                    !!nonce && componentStyles.length > 0 && componentStyles.every(style => style.nonce === nonce) &&
                    !document.querySelector('link[rel="stylesheet"][media="print"]');
                await invoke('smoke_result', { success: telemetryOk && sessionsOk && snapshotBusy && disconnectResponsive && cancelledRotation && capturedWindow && !!rendered && styled && adapterReady && malformedRejected && reply.version === 1 &&
                    reply.application === 'stellar-desktop' && reply.ready === true && rejected });
            } catch (_) { await invoke('smoke_result', { success: false }); }
        })();
    "#;
    let script = script.replace(
        "__TELEMETRY_EXPECT_LIVE__",
        if std::env::var_os("STELLAR_TELEMETRY_SMOKE_EXPECT_LIVE").is_some() {
            "true"
        } else {
            "false"
        },
    );
    if window.eval(&script).is_err() {
        window.app_handle().exit(1);
    }
}

pub fn configure(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .invoke_handler(tauri::generate_handler![
            crate::commands::shell_status,
            crate::app_info::app_info,
            crate::telemetry::telemetry_snapshot,
            crate::ivy::ivy_select_session,
            crate::ivy::ivy_clear_conversation,
            crate::ivy::ivy_disconnect,
            crate::ivy::ivy_snapshot,
            smoke_hold_ivy,
            smoke_capture_window,
            smoke_result
        ])
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                check_page(window.clone());
            }
        })
}
