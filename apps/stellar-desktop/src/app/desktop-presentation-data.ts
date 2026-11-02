import { computed, DestroyRef, inject, signal } from '@angular/core';
import {
  DesktopTelemetryService,
  IvyAdapterService,
} from '@stellar/service-desktop-adapter';
import type {
  PresentationData,
  PresentationSourceView,
} from '@stellar/ui-molecules';

export function desktopPresentationData(): PresentationData {
  const telemetry = inject(DesktopTelemetryService);
  const ivy = inject(IvyAdapterService);
  const observedAt = signal<string | null>(null);
  const healthy = signal(false);
  let owners = 0,
    generation = 0,
    pending = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const releases = new Set<() => void>();
  const refresh = async () => {
    if (pending) return;
    pending = true;
    const current = generation;
    try {
      const snapshot = await ivy.snapshot();
      if (current === generation) {
        observedAt.set(new Date().toISOString());
        healthy.set(snapshot.connection === 'ready');
      }
    } catch {
      if (current === generation) healthy.set(false);
    } finally {
      pending = false;
    }
  };
  const workflow = computed<PresentationSourceView>(() => {
    const source = telemetry.state();
    return {
      source: 'Stellar Live · Hermes leases and Codex turn history',
      observedAt: source.snapshot?.observedAt ?? null,
      state:
        source.status === 'loading'
          ? 'loading'
          : source.fresh
            ? 'available'
            : 'unavailable',
      rows: [
        ...(source.snapshot?.agents ?? []).map((agent) => ({
          id: agent.id,
          label: agent.name,
          project: agent.project,
          value:
            agent.source.health !== 'available'
              ? 'Source unavailable'
              : agent.state === 'unknown'
                ? 'State unknown'
                : agent.state,
          detail: `${agent.source.kind} · observed ${agent.source.observedAt} · model: ${agent.model ?? 'Unavailable'} · activity: ${agent.activity ?? 'Unavailable'} · tool: ${agent.tool ?? 'Unavailable'}${agent.usage ? ` · recorded tokens: ${agent.usage.inputTokens} in / ${agent.usage.outputTokens} out` : ''}`,
        })),
        {
          id: 'task-bindings',
          label: 'Task and issue bindings',
          value: 'Unavailable from this source',
        },
        {
          id: 'pull-requests',
          label: 'Pull requests and approvals',
          value: 'Not connected to this source',
        },
      ],
    };
  });
  const session = computed<PresentationSourceView>(() => {
    const snapshot = ivy.state();
    return {
      source: 'Native Ivy foreground snapshot',
      observedAt: observedAt(),
      state:
        healthy() && snapshot.connection === 'ready'
          ? 'available'
          : 'unavailable',
      rows: [
        {
          id: 'selected-model',
          label: 'Selected conversation model',
          value: snapshot.model === 'sol' ? 'Sol' : 'Terra',
        },
        {
          id: 'verified-model',
          label: 'Gateway-confirmed launch route',
          value: snapshot.verified_model ?? 'Unavailable',
        },
        { id: 'turn', label: 'Foreground turn', value: snapshot.turn },
        { id: 'connection', label: 'Connection', value: snapshot.connection },
        { id: 'context', label: 'Context utilization', value: 'Unavailable' },
        {
          id: 'tools',
          label: 'Tool execution and delegated tasks',
          value: 'Unavailable from this snapshot',
        },
      ],
    };
  });
  const acquire = () => {
    const releaseTelemetry = telemetry.acquire();
    if (++owners === 1) {
      generation++;
      void refresh();
      timer = setInterval(() => void refresh(), 5000);
    }
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      releases.delete(release);
      releaseTelemetry();
      if (--owners === 0) {
        generation++;
        clearInterval(timer);
        timer = undefined;
        healthy.set(false);
      }
    };
    releases.add(release);
    return release;
  };
  inject(DestroyRef).onDestroy(() => {
    for (const release of [...releases]) release();
  });
  return { workflow, session, acquire };
}
