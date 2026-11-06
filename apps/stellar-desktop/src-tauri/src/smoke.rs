use tauri::{Manager, Webview, Wry};

#[tauri::command]
fn smoke_result(
    app: tauri::AppHandle,
    success: bool,
    workspace_metrics: Option<Vec<f64>>,
    stage: Option<String>,
    diagnostics: Option<Vec<bool>>,
    volume_probe: Option<bool>,
    awareness_checks: Option<Vec<bool>>,
) {
    if let Some(checks) = awareness_checks
        && checks.len() <= 12
    {
        println!(
            "STELLAR_AWARENESS_CHECKS {}",
            serde_json::to_string(&checks).unwrap_or_default()
        );
    }
    if let Some(performed) = volume_probe {
        println!("STELLAR_DUCKING_PROBE {performed}");
    }
    if let Some(metrics) = workspace_metrics
        && metrics.len() == 5
        && metrics
            .iter()
            .all(|n| n.is_finite() && *n >= 0. && *n < 30000.)
    {
        println!(
            "STELLAR_WORKSPACE_METRICS {}",
            serde_json::to_string(&metrics).unwrap_or_default()
        );
    }
    if let Some(stage) = stage
        && stage.len() <= 40
        && stage
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        println!("STELLAR_SMOKE_STAGE {stage}");
    }
    if let Some(values) = diagnostics
        && values.len() <= 24
    {
        println!(
            "STELLAR_SMOKE_CHECKS {}",
            serde_json::to_string(&values).unwrap_or_default()
        );
    }
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
async fn smoke_capture_window(app: tauri::AppHandle, detailed: Option<bool>) -> bool {
    println!("STELLAR_SMOKE_STAGE capture-window-start");
    let captured =
        tauri::async_runtime::spawn_blocking(move || crate::ivy::capture_workspace_window(&app))
            .await
            .is_ok_and(|result| {
                result.is_ok_and(|image| {
                    if detailed == Some(true) {
                        let Ok(decoded) = ::image::load_from_memory(&image) else {
                            return false;
                        };
                        println!(
                            "STELLAR_SMOKE_STAGE detailed-capture-{}x{}-bytes{}",
                            decoded.width(),
                            decoded.height(),
                            image.len()
                        );
                        if std::fs::write("artifacts/native/detailed-workspace.png", &image)
                            .is_err()
                        {
                            return false;
                        }
                    }
                    image.starts_with(b"\x89PNG\r\n\x1a\n") && image.len() <= 4 * 1024 * 1024
                })
            });
    println!("STELLAR_SMOKE_STAGE capture-window-end");
    captured
}

fn check_page(window: Webview) {
    let script = r#"
        (async () => {
            const invoke = window.__TAURI__.core.invoke;
            let stage='startup';let workspaceChecks=[];let volumeProbe=false;
            try {
                for (let n = 0; n < 100 && !(document.querySelector('stellar-root')?.getAttribute('data-desktop-ready') === 'true' &&
                    document.querySelector('stellar-root')?.getAttribute('data-desktop-event') === 'true'); n++)
                    await new Promise(resolve => setTimeout(resolve, 100));
                let telemetryOk = false;
                try { const snapshot = await invoke('telemetry_snapshot'); telemetryOk = snapshot.schemaVersion === 1; }
                catch (error) { telemetryOk = !__TELEMETRY_EXPECT_LIVE__ && ['unavailable', 'timeout', 'invalid'].includes(error); }
                const reply = await invoke('shell_status', { request: { version: 1 } });
                const music = await invoke('music_set_enabled', { request: { version: 1, enabled: false } });
                let musicRejected = false;
                try { await invoke('music_set_enabled', { request: { version: 2, enabled: true } }); }
                catch (error) { musicRejected = error === 'unsupported_version'; }
                const musicOk = musicRejected && music.status === 'idle' && music.tone === null && Object.values(music.levels).every(value => value === 0);
                const reflexMedia = await invoke('reflex_media_snapshot');
                let duckingRejected = false;
                try { await invoke('speech_set_ducking', {request:{version:2,active:true}}); }
                catch(error) { duckingRejected = error === 'unsupported_version'; }
                if (!duckingRejected) throw Error('Ducking version validation failed');
                if (reflexMedia.volume !== null) {
                  try {
                    await invoke('speech_set_ducking', {request:{version:1,active:true}});
                    await new Promise(resolve=>setTimeout(resolve,1000));
                    const lowered = await invoke('reflex_media_snapshot');
                    await invoke('speech_set_ducking', {request:{version:1,active:true}});
                    await new Promise(resolve=>setTimeout(resolve,100));
                    const held = await invoke('reflex_media_snapshot');
                    if (lowered.endpoint_id !== reflexMedia.endpoint_id || lowered.muted !== reflexMedia.muted || lowered.volume !== reflexMedia.volume || held.volume !== reflexMedia.volume)
                        throw Error('Ducking changed master volume or mute');
                  } finally { await invoke('speech_set_ducking', {request:{version:1,active:false}}); }
                  await new Promise(resolve=>setTimeout(resolve,1000));
                  const restored = await invoke('reflex_media_snapshot');
                  if (restored.volume !== reflexMedia.volume || restored.muted !== reflexMedia.muted) throw Error('System volume restoration failed');
                  volumeProbe=true;
                } else await invoke('speech_set_ducking', {request:{version:1,active:false}});
                const reflexRoute = await invoke('reflex_route',{request:{version:1,input_id:'smoke-substantive',text:'Please show me my latest github issue',mode:'professional',context:'{}',history:[],actions:[]}});
                if(reflexRoute.version!==1 || reflexRoute.local!==false) throw Error('Substantive request did not delegate');
                const reflexStatus = await invoke('reflex_status');
                if(reflexStatus.version!==1 || typeof reflexStatus.configured!=='boolean') throw Error('Reflex readiness contract failed');
                await invoke('reflex_set_enabled',{enabled:false});
                const reflexCold = await invoke('reflex_prepare');
                if(reflexCold.version!==1 || reflexCold.configured!==false) throw Error('Disabled Reflex started');
                await invoke('reflex_set_enabled',{enabled:true});
                const reflexRejected = await invoke('reflex_media_execute', {request:{version:1,input_id:'smoke-invalid-ticket',ticket:'never-issued',action:'next'}});
                if(!/^\d+$/.test(reflexMedia.ticket) || !Array.isArray(reflexMedia.actions) || reflexRejected !== 'rejected') throw Error('Reflex native read-only probe failed');
                const reflexPlan = await invoke('reflex_infer', {request:{version:2,input_id:'smoke-model-contract',text:'skip',mode:'professional',context:'{}',history:[],actions:[]}});
                if(reflexPlan.version!==1 || reflexPlan.input_id!=='smoke-model-contract' || reflexPlan.plan!==null) throw Error('Reflex model contract probe failed');
                await invoke('reflex_cancel',{inputId:'smoke-model-contract'});
                let workspaceMetrics=null;
                let mediaRejected=0;
                for (const url of ['file:///secret','https://127.0.0.1/','https://169.254.169.254/']) {
                    try { await invoke('workspace_browser',{request:{version:1,operation:{action:'open',generation:1,id:'00000000-0000-4000-8000-000000000001',url,bounds:{x:20,y:120,width:500,height:300,visible:true}}}}); }
                    catch (error) { if(error === 'blocked') mediaRejected++; }
                }
                let mediaOk=mediaRejected === 3;
                if (__WORKSPACE_LIVE__) {
                    const id='00000000-0000-4000-8000-000000000001';
                    let loaded=false,focused=false,readyGeneration=0; const observedUrls=[];
                    const unlisten=await window.__TAURI__.event.listen('stellar-browser',event=>{if(event.payload.id===id && event.payload.state==='ready') {loaded=true;readyGeneration=event.payload.generation;observedUrls.push(event.payload.url);} if(event.payload.id===id && event.payload.state==='focused') focused=true;});
                    const start=performance.now();
                    stage='browser-create';
                    await invoke('workspace_browser',{request:{version:1,operation:{action:'open',generation:1,id,url:'https://example.com/',bounds:{x:20,y:140,width:700,height:420,visible:true}}}});
                    stage='browser-load';
                    for(let n=0;n<100 && !loaded;n++) await new Promise(resolve=>setTimeout(resolve,100));
                    const creationMs=performance.now()-start;
                    const probe=loaded && await invoke('smoke_media_probe');
                    const operations=[];
                    for(const width of [400,650,450,700]) {
                        const before=performance.now();
                        await invoke('workspace_browser',{request:{version:1,operation:{action:'bounds',id,bounds:{x:20,y:140,width,height:420,visible:true}}}});
                        operations.push(performance.now()-before);
                    }
                    stage='image-fetch';
                    const preview=await invoke('workspace_image',{request:{version:1,url:'https://www.w3.org/assets/logos/w3c-2025-transitional/w3c-72x48.png'}});
                    const remoteImage=preview.data_uri.startsWith('data:image/png;base64,') && preview.width>0 && preview.width<=1600 && preview.height<=1200;
                    const image=document.createElement('img');image.src=preview.data_uri;image.alt='Native remote image preview';image.style.position='fixed';image.style.left='760px';image.style.top='140px';document.body.append(image);
                    const retained=await invoke('smoke_media_probe',{retained:true});
                    const sourceChanged=observedUrls.some(url=>url.endsWith('#stellar-source-smoke'));
                    for(const [action,generation,url] of [['navigate',2,'https://example.com/#workspace-fragment'],['back',3,null],['forward',4,null],['reload',5,null]]){
                        stage='browser-'+action;
                        await invoke('workspace_browser',{request:{version:1,operation:{action,id,generation,...(url?{url}:{})}}});
                        for(let n=0;n<100 && readyGeneration<generation;n++) await new Promise(resolve=>setTimeout(resolve,50));
                        if(readyGeneration<generation) throw Error('Native navigation did not settle');
                    }
                    await invoke('smoke_media_probe');
                    await invoke('workspace_browser',{request:{version:1,operation:{action:'close',id}}});
                    unlisten();
                    workspaceChecks=[loaded,probe,retained,focused,remoteImage,sourceChanged];
                    mediaOk=mediaOk && probe && retained && focused && remoteImage && sourceChanged;
                    workspaceMetrics=[creationMs,...operations];
                    console.log('STELLAR_WORKSPACE_LIVE',JSON.stringify({creationMs,boundsMs:operations,loaded,isolated:probe,retained}));
                }
                stage='local-checks';
                const awarenessChecks = await (__AWARENESS_SMOKE__);
                const awarenessOk = awarenessChecks.every(Boolean);
                let rejected = false;
                try { await invoke('shell_status', { request: { version: 2 } }); }
                catch (error) { rejected = error.code === 'unsupported_version' && error.received === 2; }
                let malformedRejected = false;
                try { await invoke('app_info', { request: { version: '1', sequence: '0' } }); }
                catch (error) { malformedRejected = error.code === 'malformed_request'; }
                const cleanup = await invoke('cleanup_refine', { request: { version: 2, raw: 'synthetic' } });
                const cleanupRejected = cleanup.version === 1 && cleanup.text === null;
                stage='inspector-request-validation';
                let inspectorRejected=0;
                for(const request of [
                  {version:2,session_id:null,offset:0,before_message:null},
                  {version:1,session_id:'',offset:0,before_message:null}
                ]) {
                  try { await invoke('ivy_inspect',{request}); }
                  catch(error) { if(error==='malformed_request')inspectorRejected++; }
                }
                if(inspectorRejected!==2)throw Error('Inspector malformed contract failed');
                stage='lifecycle-validation';
                let lifecycleRejected = 0;
                for (const name of ['ivy_new_session', 'ivy_reload_mcp', 'ivy_question_reply']) {
                    try { await invoke(name, { request: { version: 2 } }); }
                    catch (error) { if (error === 'malformed_request') lifecycleRejected++; }
                }
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
                stage='inspector-disconnected';
                let inspectorUnavailable=false;
                try { await invoke('ivy_inspect',{request:{version:1,session_id:null,offset:0,before_message:null}}); }
                catch(error) { inspectorUnavailable=error==='unavailable'; }
                if(!inspectorUnavailable)throw Error('Disconnected inspector read-only contract failed');
                stage='local-checks';
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
                if (__WORKSPACE_LIVE__) {
                    stage='detailed-window-capture';
                    if (!await (__DETAILED_CAPTURE__)) throw Error('Repeated detailed window capture failed');
                }
                await invoke('smoke_result', { workspaceMetrics, stage, volumeProbe, awarenessChecks, diagnostics:[awarenessOk,musicOk,...workspaceChecks,mediaOk,lifecycleRejected===3,cleanupRejected,telemetryOk,sessionsOk,snapshotBusy,disconnectResponsive,cancelledRotation,capturedWindow,!!rendered,styled,adapterReady,malformedRejected,rejected], success: awarenessOk && musicOk && mediaOk && lifecycleRejected === 3 && cleanupRejected && telemetryOk && sessionsOk && snapshotBusy && disconnectResponsive && cancelledRotation && capturedWindow && !!rendered && styled && adapterReady && malformedRejected && reply.version === 1 &&
                    reply.application === 'stellar-desktop' && reply.ready === true && rejected });
            } catch (error) { if(typeof error==='string' && ['blocked','limit','unavailable','malformed'].includes(error))stage+='-'+error; await invoke('smoke_result', { success:false,stage }); }
        })();
    "#;
    let script = script.replace(
        "__AWARENESS_SMOKE__",
        include_str!("awareness/smoke.js")
            .trim()
            .trim_end_matches(';'),
    );
    let script = script.replace(
        "__DETAILED_CAPTURE__",
        include_str!("smoke_capture.js")
            .trim()
            .trim_end_matches(';'),
    );
    let script = script.replace(
        "__TELEMETRY_EXPECT_LIVE__",
        if std::env::var_os("STELLAR_TELEMETRY_SMOKE_EXPECT_LIVE").is_some() {
            "true"
        } else {
            "false"
        },
    );
    let script = script.replace(
        "__WORKSPACE_LIVE__",
        if std::env::var_os("STELLAR_WORKSPACE_SMOKE_LIVE").is_some() {
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
            crate::reflex::reflex_media_snapshot,
            crate::speech::speech_set_ducking,
            crate::reflex::reflex_media_execute,
            crate::reflex::reflex_infer,
            crate::reflex::reflex_route,
            crate::reflex::reflex_prepare,
            crate::reflex::reflex_status,
            crate::reflex::reflex_set_enabled,
            crate::reflex::reflex_cancel,
            crate::commands::shell_status,
            crate::awareness::awareness_snapshot,
            crate::awareness::awareness_set_enabled,
            crate::awareness::awareness_workspace,
            crate::music::music_set_enabled,
            crate::media::workspace_browser,
            crate::media::workspace_image,
            crate::media::smoke::smoke_media_probe,
            crate::cleanup::cleanup_refine,
            crate::app_info::app_info,
            crate::telemetry::telemetry_snapshot,
            crate::ivy::ivy_select_session,
            crate::ivy::ivy_clear_conversation,
            crate::ivy::ivy_new_session,
            crate::ivy::ivy_reload_mcp,
            crate::ivy::ivy_question_reply,
            crate::ivy::ivy_disconnect,
            crate::ivy::ivy_snapshot,
            crate::ivy::inspector::ivy_inspect,
            smoke_hold_ivy,
            smoke_capture_window,
            smoke_result
        ])
        .on_page_load(|window, payload| {
            if window.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                let _ = window.window().set_focus();
                if std::env::var_os("STELLAR_WORKSPACE_SMOKE_LIVE").is_some() {
                    let _ = window
                        .window()
                        .set_size(tauri::LogicalSize::new(1920., 1080.));
                }
                check_page(window.clone());
            }
        })
}
