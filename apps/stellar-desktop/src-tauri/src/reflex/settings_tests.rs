use super::*;

#[test]
fn disabling_invalidates_inflight_generation_and_enable_cannot_reopen_shutdown() {
    let host = ReflexHost::default();
    host.0.lock().unwrap().busy = Some("pending".into());
    let before = host.0.lock().unwrap().generation;
    host.set_enabled(false);
    {
        let state = host.0.lock().unwrap();
        assert!(state.disabled);
        assert!(state.busy.is_none());
        assert!(state.generation > before);
    }
    let request = ReflexRequest {
        version: 1,
        input_id: "settings".into(),
        text: "Write some code".into(),
        mode: ReflexMode::Professional,
        context: "{}".into(),
        history: vec![],
        actions: vec![],
    };
    assert!(tauri::async_runtime::block_on(host.infer(&request)).is_none());
    host.set_enabled(true);
    assert!(tauri::async_runtime::block_on(host.infer(&request)).is_some());
    host.shutdown();
    host.set_enabled(true);
    assert!(tauri::async_runtime::block_on(host.infer(&request)).is_none());
}
