(async () => {
  const invoke = window.__TAURI__.core.invoke;
  let observed;
  for (let n = 0; n < 30; n++) {
    observed = await invoke('awareness_snapshot', { request: { version: 1 } });
    if (observed.foreground) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let rejected = false;
  try {
    await invoke('awareness_snapshot', { request: { version: 2 } });
  } catch (error) {
    rejected = error === 'malformed_request';
  }
  const before = await invoke('ivy_snapshot', { request: { version: 1 } });
  let workspaceRejected = false;
  try {
    await invoke('awareness_workspace', {
      request: {
        version: 1,
        epoch: before.workspace_epoch,
        panes: [
          {
            title: 'Synthetic',
            surface: 'executable',
            selected: false,
            minimized: false,
          },
        ],
      },
    });
  } catch (error) {
    workspaceRejected = error === 'malformed_request';
  }
  const paused = await invoke('awareness_set_enabled', {
    request: { version: 1, enabled: false },
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const quiet = await invoke('awareness_snapshot', { request: { version: 1 } });
  const resumed = await invoke('awareness_set_enabled', {
    request: { version: 1, enabled: true },
  });
  return [
    rejected,
    workspaceRejected,
    observed?.version === 1,
    observed.app_health === 'available' && !!observed.foreground,
    !paused.enabled && paused.foreground === null && paused.spotify === null,
    quiet.revision === paused.revision,
    quiet.app_health === 'paused' && quiet.media_health === 'paused',
    resumed.enabled,
  ];
})();
