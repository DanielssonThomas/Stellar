import {
  afterNextRender,
  Component,
  DestroyRef,
  effect,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { DesktopExperienceTemplate } from '@stellar/ui-templates/desktop-experience';
import { DesktopExperience } from './desktop-experience';
import { DesktopAssistant } from './desktop-assistant';
import { DesktopVoice } from './desktop-voice';
import {
  DesktopAdapterService,
  DesktopAwarenessService,
  IvyAdapterService,
  WorkspaceToolsService,
  MusicVisualizerService,
  createNativeMediaWorkspace,
  IvyReflexService,
  IvyInspectorService,
  type MediaNativeApi,
} from '@stellar/service-desktop-adapter';
import {
  capabilityLabel,
  type IvyQuestionAction,
} from '@stellar/desktop-contracts';
import {
  PRESENTATION_DATA,
  PRESENTATION_WORKSPACE,
} from '@stellar/ui-molecules';
import { desktopPresentationData } from './desktop-presentation-data';
import { desktopWorkspace } from './desktop-workspace';
import { desktopReflex } from './desktop-reflex';
import { DesktopFaults } from './desktop-faults';

@Component({
  imports: [DesktopExperienceTemplate],
  providers: [
    DesktopExperience,
    DesktopAssistant,
    DesktopVoice,
    DesktopFaults,
    MusicVisualizerService,
    { provide: PRESENTATION_DATA, useFactory: desktopPresentationData },
    {
      provide: PRESENTATION_WORKSPACE,
      useFactory: () => {
        const api = (
          globalThis as typeof globalThis & { __TAURI__?: MediaNativeApi }
        ).__TAURI__;
        return api
          ? createNativeMediaWorkspace(api)
          : inject(PRESENTATION_WORKSPACE, { skipSelf: true });
      },
    },
  ],
  selector: 'stellar-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  host: {
    '[attr.data-desktop-ready]': 'desktopReady()',
    '[attr.data-desktop-event]': 'eventSeen()',
    '[attr.data-desktop-capabilities]': 'capabilities()',
  },
})
export class AppComponent {
  readonly inspector = inject(IvyInspectorService);
  inspectorVisible(visible: boolean) {
    if (visible) this.inspector.open();
    else this.inspector.close();
  }
  async newInspectorSession() {
    if (await this.voice.newSession()) {
      this.inspector.select(null);
    }
  }
  private readonly injector = inject(Injector);
  async questionShown(id: string) {
    try {
      const state = await this.ivy.questionReply(id, { kind: 'shown' });
      if (
        state.questions?.some(
          (question) => question.id === id && question.shown,
        )
      )
        this.voice.notifyQuestion(id);
    } catch {
      /* The card remains visible while the native connection recovers. */
    }
  }

  async answerQuestion(id: string, action: IvyQuestionAction) {
    try {
      await this.ivy.questionReply(id, action);
    } catch {
      /* The adapter exposes native recovery state. */
    }
  }
  readonly title = 'Stellar Desktop';
  readonly experience = inject(DesktopExperience);
  readonly assistant = inject(DesktopAssistant);
  readonly voice = inject(DesktopVoice);
  readonly faults = inject(DesktopFaults);
  readonly music = inject(MusicVisualizerService);
  readonly reflex = inject(IvyReflexService);
  readonly awareness = inject(DesktopAwarenessService);
  readonly faultRecovering = signal(false);
  private readonly view = viewChild.required(DesktopExperienceTemplate);
  readonly desktopReady = signal(false);
  readonly eventSeen = signal(false);
  readonly capabilities = signal('');
  private readonly adapter = inject(DesktopAdapterService);
  private readonly ivy = inject(IvyAdapterService);
  private readonly workspace = inject(WorkspaceToolsService);

  constructor() {
    let hadActiveFault = false;
    let recoveredTimer: ReturnType<typeof setTimeout> | undefined;
    inject(DestroyRef).onDestroy(() => clearTimeout(recoveredTimer));
    const runtimeError = () => this.faults.observe('desktop', 'runtime');
    const scriptError = (event: ErrorEvent) => {
      if (event.error || event.message) runtimeError();
    };
    globalThis.addEventListener('error', scriptError);
    globalThis.addEventListener('unhandledrejection', runtimeError);
    inject(DestroyRef).onDestroy(() => {
      globalThis.removeEventListener('error', scriptError);
      globalThis.removeEventListener('unhandledrejection', runtimeError);
    });
    effect(() => {
      const ivy = this.assistant.state();
      const browserPreview = !Object.hasOwn(globalThis, '__TAURI__');
      this.faults.observe(
        'assistant',
        (browserPreview && ivy.error === 'unavailable' && ivy.turn === 'idle'
          ? null
          : ivy.error) ??
          (ivy.turn === 'uncertain'
            ? 'uncertain'
            : ivy.turn === 'failed'
              ? 'failed'
              : ivy.connection === 'unavailable' && !browserPreview
                ? 'unavailable'
                : null),
      );
      this.faults.observe(
        'voice',
        this.voice.state().error && !browserPreview
          ? this.voice.sessionUnavailable()
            ? 'session'
            : 'failure'
          : null,
      );
      this.faults.observe(
        'artwork',
        this.experience.assetError() ? 'unavailable' : null,
      );
      const mic = this.experience.state().microphone.status;
      this.faults.observe(
        'microphone',
        ['denied', 'missing', 'disconnected'].includes(mic) ? mic : null,
      );
      if (this.assistant.recovery() === 'checking')
        this.faults.beginRecovery('assistant');
      else if (['failed', 'unchanged'].includes(this.assistant.recovery()))
        this.faults.endRecovery('assistant', false);
      const active = this.faults.active();
      if (active) clearTimeout(recoveredTimer);
      else if (hadActiveFault)
        recoveredTimer = setTimeout(() => {
          if (!this.faults.active()) this.faults.dismiss();
        }, 2000);
      hadActiveFault = active;
    });
    afterNextRender(() => {
      void this.ivy.connect().catch(() => undefined);
      void this.awareness.start();
    });
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      this.experience.connect(
        (command) => this.view().dispatch(command),
        () => this.view().stage().nextCommandId(),
      );
      let signature = '';
      const observeWorkspace = () => {
        const value = {
          version: 1,
          epoch: this.assistant.state().workspace_epoch,
          panes: this.view()
            .stage()
            .inspectPresentations()
            .slice(0, 8)
            .map((pane) => ({
              title: [...pane.title]
                .filter((char) => {
                  const code = char.codePointAt(0) ?? 0;
                  return code >= 32 && (code < 127 || code > 159);
                })
                .slice(0, 80)
                .join(''),
              surface: pane.surface,
              selected: pane.selected,
              minimized: pane.minimized,
            })),
        };
        const next = JSON.stringify(value);
        if (next !== signature) {
          signature = next;
          this.awareness.workspace(value);
        }
      };
      const awarenessTimer = setInterval(() => {
        signature = '';
        observeWorkspace();
      }, 5000);
      destroy.onDestroy(() => clearInterval(awarenessTimer));
      effect(observeWorkspace, { injector: this.injector });
      destroy.onDestroy(
        this.voice.bindPromptPresentation((text, signal) =>
          text.model === 'sol'
            ? this.view().presentFinalizedPrompt(text, signal)
            : Promise.resolve(),
        ),
      );
      const unbind = this.workspace.bind(
        desktopWorkspace({
          stage: this.view().stage(),
          present: (command) => this.experience.present(command),
          available: () =>
            !['suspended', 'shutdown'].includes(this.experience.state().phase),
          isCurrent: (request) => this.workspace.isCurrent(request),
        }),
      );
      destroy.onDestroy(unbind);
      this.reflex.bind(
        desktopReflex({
          stage: this.view().stage(),
          present: (command) => this.experience.present(command),
          available: () =>
            !['suspended', 'shutdown'].includes(this.experience.state().phase),
        }),
        () =>
          `${this.assistant.state().workspace_epoch}:${this.assistant.state().reset_id}:${this.assistant.state().model}:${this.experience.state().phase === 'suspended' || this.experience.state().phase === 'shutdown'}`,
      );
      this.voice.bindForegroundClear((reason) => {
        this.reflex.clear();
        this.view().stage().closePresentations();
        if (reason === 'new_session') {
          this.view().draft.set('');
          this.view().menu.close();
        }
      });
      this.assistant.bind(
        (command) => {
          const commandId = this.view().stage().nextCommandId();
          return commandId === null
            ? { status: 'rejected', reason: 'sequence-exhausted' }
            : this.experience.present({ ...command, commandId });
        },
        () =>
          !['suspended', 'shutdown'].includes(this.experience.state().phase),
        () => this.view().stage().presentationIds(),
      );
    });
    let destroyed = false;
    let unsubscribe: () => void = () => undefined;
    inject(DestroyRef).onDestroy(() => {
      destroyed = true;
      unsubscribe();
    });
    void (async () => {
      try {
        const stop = await this.adapter.subscribe(
          (event) => {
            if (!destroyed && event.info.sequence === '18446744073709551615')
              this.eventSeen.set(true);
          },
          () => this.desktopReady.set(false),
        );
        if (destroyed) {
          stop();
          return;
        }
        unsubscribe = stop;
        const info = await this.adapter.appInfo({
          version: 1,
          sequence: '18446744073709551615',
        });
        if (!destroyed) {
          this.capabilities.set(
            info.capabilities.map(capabilityLabel).join(', '),
          );
          this.desktopReady.set(true);
          if (
            info.capabilities.some(
              (capability) => capability.kind === 'native_window',
            )
          )
            void this.voice.startListening();
        }
      } catch {
        unsubscribe();
      }
    })();
  }

  async recoverFault() {
    if (this.faultRecovering()) return;
    this.faultRecovering.set(true);
    this.faults.beginRecovery('assistant');
    this.faults.beginRecovery('voice');
    try {
      if (this.assistant.uncertain()) await this.assistant.reconcile();
      else await this.assistant.retry();
      await this.voice.retry();
    } finally {
      this.faultRecovering.set(false);
      const state = this.assistant.state();
      this.faults.endRecovery(
        'assistant',
        state.connection === 'ready' &&
          !state.error &&
          state.turn !== 'uncertain',
      );
      this.faults.endRecovery('voice', !this.voice.state().error);
    }
  }
}
