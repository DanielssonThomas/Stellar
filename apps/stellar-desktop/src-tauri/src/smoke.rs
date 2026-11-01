use tauri::{Manager, Webview, Wry};

#[tauri::command]
fn smoke_result(app: tauri::AppHandle, success: bool) {
    if success {
        println!("STELLAR_NATIVE_SMOKE_OK");
    }
    app.exit(if success { 0 } else { 1 });
}

fn check_page(window: Webview) {
    let script = r#"
        (async () => {
            const invoke = window.__TAURI__.core.invoke;
            try {
                for (let n = 0; n < 100 && !document.querySelector('h1'); n++)
                    await new Promise(resolve => setTimeout(resolve, 100));
                const reply = await invoke('shell_status', { request: { version: 1 } });
                let rejected = false;
                try { await invoke('shell_status', { request: { version: 2 } }); }
                catch (error) { rejected = error.code === 'unsupported_version' && error.received === 2; }
                const rendered = document.querySelector('h1')?.textContent?.includes('Stellar Desktop');
                const rootStyle = getComputedStyle(document.querySelector('stellar-root'));
                const mainStyle = getComputedStyle(document.querySelector('main'));
                const nonce = document.querySelector('#stellar-csp-anchor')?.nonce;
                const componentStyles = [...document.querySelectorAll('style')].filter(style =>
                    style.id !== 'stellar-csp-anchor' && style.textContent.includes('_nghost'));
                const styled = rootStyle.display === 'block' && mainStyle.display === 'flex' &&
                    mainStyle.alignItems === 'center' && mainStyle.justifyContent === 'center' &&
                    parseFloat(mainStyle.minHeight) >= window.innerHeight &&
                    !!nonce && componentStyles.length > 0 && componentStyles.every(style => style.nonce === nonce) &&
                    !document.querySelector('link[rel="stylesheet"][media="print"]');
                await invoke('smoke_result', { success: !!rendered && styled && reply.version === 1 &&
                    reply.application === 'stellar-desktop' && reply.ready === true && rejected });
            } catch (_) { await invoke('smoke_result', { success: false }); }
        })();
    "#;
    if window.eval(script).is_err() {
        window.app_handle().exit(1);
    }
}

pub fn configure(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .invoke_handler(tauri::generate_handler![
            crate::commands::shell_status,
            smoke_result
        ])
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                check_page(window.clone());
            }
        })
}
