export * from './lib/services/desktop-adapter.service';
export {
  DesktopAwarenessService,
  AWARENESS_TRANSPORT,
} from './lib/services/desktop-awareness.service';
export type { AwarenessTransport } from './lib/services/desktop-awareness.service';
export { IvyReflexService } from './lib/services/ivy-reflex.service';
export { LocalActionRegistry } from './lib/reflex/action-registry';
export type { LocalAction } from './lib/reflex/action-registry';
export { ReflexController } from './lib/reflex/reflex-controller';
export { reflexPercentiles } from './lib/reflex/reflex-latency';
export type {
  ReflexOutcome,
  ReflexEnvironment,
  ReflexEvent,
} from './lib/reflex/reflex-controller';
export { DesktopAdapter, DesktopAdapterError } from './lib/desktop-adapter';
export {
  createBrowserDesktopTransport,
  createNativeDesktopTransport,
} from './lib/desktop-transport';
export type {
  DesktopTransport,
  NativeDesktopApi,
} from './lib/desktop-transport';
export { IvyAdapter, IvyAdapterError } from './lib/ivy/ivy-adapter';
export {
  nativeIvyTransport,
  browserIvyTransport,
  initialIvySnapshot,
} from './lib/ivy/ivy-transport';
export type { IvyTransport, IvyNativeApi } from './lib/ivy/ivy-transport';
export {
  WorkspaceToolsService,
  WORKSPACE_TOOL_TRANSPORT,
} from './lib/services/workspace-tools.service';
export type {
  WorkspaceToolHandler,
  WorkspaceToolTransport,
} from './lib/services/workspace-tools.service';
export {
  IvyAdapterService,
  IVY_TRANSPORT,
} from './lib/services/ivy-adapter.service';
export { SpeechAdapter, SpeechAdapterError } from './lib/speech/speech-adapter';
export {
  nativeSpeechTransport,
  browserSpeechTransport,
  initialSpeechSnapshot,
} from './lib/speech/speech-transport';
export type {
  SpeechTransport,
  SpeechNativeApi,
} from './lib/speech/speech-transport';
export {
  SpeechAdapterService,
  SPEECH_TRANSPORT,
} from './lib/services/speech-adapter.service';
export { VoiceConversation } from './lib/speech/voice-conversation';
export type {
  VoiceContext,
  VoiceView,
  VoicePorts,
} from './lib/speech/voice-conversation';
export { createPromptCleanup } from './lib/speech/prompt-cleanup';
export type {
  PromptCleanupProvider,
  PromptCleanupResult,
} from './lib/speech/prompt-cleanup';

export { createNativePromptCleanup } from './lib/speech/native-prompt-cleanup';
export type { CleanupInvoke } from './lib/speech/native-prompt-cleanup';
export { PromptCleanupService } from './lib/services/prompt-cleanup.service';
export {
  DesktopTelemetryService,
  DESKTOP_TELEMETRY_TRANSPORT,
} from './lib/services/desktop-telemetry.service';
export type {
  VoiceComposition,
  VoiceModel,
  VoiceCommand,
} from './lib/speech/voice-composition';

export type {
  FinalizedPrompt,
  PromptPresentation,
} from './lib/speech/prompt-presentation';
export {
  MusicVisualizerService,
  MUSIC_TRANSPORT,
} from './lib/services/music-visualizer.service';
export type { MusicTransport } from './lib/music/music-transport';
export { createNativeMediaWorkspace } from './lib/media/media-workspace';
export type { MediaNativeApi } from './lib/media/browser-pane';
export type { RequestTrace, RequestStep } from './lib/reflex/request-timeline';
export { QuestionVoiceCue } from './lib/speech/question-voice-cue';
