export type { ShellRequest, ShellReply, ShellError } from './generated';
export type {
  ReflexChoice,
  ReflexAvailability,
  ReflexRouting,
  ReflexMode,
  ReflexRequest,
  ReflexRoute,
  ReflexPlan,
  ReflexReply,
  ReflexMediaAction,
  ReflexMediaRequest,
  ReflexMediaState,
  ReflexMediaResult,
} from './generated';
export {
  decodeReflexReply,
  decodeReflexAvailability,
  decodeReflexRouting,
  decodeReflexMediaState,
  decodeReflexMediaResult,
} from './lib/reflex-codec';
export type {
  MusicRequest,
  MusicLevels,
  MusicStatus,
  MusicSnapshot,
  MusicError,
} from './generated';
export { musicSetEnabledCommand, musicEvent } from './generated';
export { decodeMusicSnapshot } from './lib/music-codec';
export { decodeShellReply } from './lib/decode-shell-reply';
export type {
  AppCapability,
  AppInfoRequest,
  AppInfoReply,
  AppInfoError,
  AppInfoEvent,
  DesktopCommands,
  DesktopEvents,
} from './generated';
export { appInfoCommand, appInfoEvent } from './generated';
export {
  DesktopContractError,
  decodeAppInfoRequest,
  decodeAppInfoReply,
  decodeAppInfoEvent,
  decodeAppInfoError,
} from './lib/app-info-codec';
export { capabilityLabel } from './lib/capability-label';
export type {
  IvyActivity,
  IvyActivityKind,
  IvyActivityState,
  IvyConnectionState,
  IvyTurnState,
  IvyErrorCode,
  IvyModel,
  IvySelectRequest,
  IvyRequest,
  IvySubmitRequest,
  IvyComponent,
  IvyPresentation,
  IvySnapshot,
  IvyCommands,
  WorkspaceToolsState,
  WorkspaceSurface,
  WorkspaceProminence,
  WorkspaceToolOperation,
  WorkspaceDisplay,
  WorkspaceToolRequest,
  WorkspacePaneMetadata,
  WorkspaceToolOutcome,
  WorkspaceToolReply,
} from './generated';
export {
  ivyConnectCommand,
  ivySnapshotCommand,
  ivySubmitCommand,
  ivyCancelCommand,
  ivyReconcileCommand,
  ivyDisconnectCommand,
  ivySelectSessionCommand,
  ivyClearConversationCommand,
  ivyNewSessionCommand,
  ivyReloadMcpCommand,
  ivyEvent,
  workspaceToolEvent,
  workspaceToolReplyCommand,
} from './generated';
export {
  decodeIvyRequest,
  decodeIvySelectRequest,
  decodeIvySubmitRequest,
  decodeIvyError,
  decodeIvySnapshot,
} from './lib/ivy-codec';
export {
  decodeWorkspaceToolRequest,
  decodeWorkspaceToolOutcome,
} from './lib/workspace-codec';
export type {
  SpeechState,
  SpeechError,
  SpeechRequest,
  SpeechStopRequest,
  SpeechTranscribeRequest,
  SpeechTranscript,
  SpeechSpeakRequest,
  SpeechSnapshot,
  SpeechCommands,
  KeywordMode,
  KeywordCommand,
  KeywordRequest,
  KeywordDetection,
  KeywordReply,
} from './generated';
export {
  speechTranscribeCommand,
  speechCollectCommand,
  speechKeywordsCommand,
  speechSpeakCommand,
  speechStopCommand,
  speechSnapshotCommand,
  speechEvent,
} from './generated';
export {
  decodeSpeechRequest,
  decodeSpeechStopRequest,
  decodeSpeechTranscribeRequest,
  decodeSpeechTranscript,
  decodeSpeechSpeakRequest,
  decodeSpeechSnapshot,
  decodeSpeechError,
} from './lib/speech-codec';
export { decodeKeywordRequest, decodeKeywordReply } from './lib/keyword-codec';

export type { CleanupRequest, CleanupReply } from './generated';
export type { SpeechTiming, SpeechTimingStage } from './generated';
export { cleanupRefineCommand } from './generated';
export { decodeCleanupReply } from './lib/cleanup-codec';
export type {
  TelemetrySnapshot,
  TelemetryAgent,
  TelemetrySource,
  TelemetryUsage,
  TelemetryEvent,
  TelemetryProject,
  TelemetryState,
  TelemetryHealth,
  TelemetrySourceKind,
  TelemetryEventKind,
  TelemetryError,
} from './generated';
export { decodeTelemetrySnapshot } from './lib/telemetry-codec';

export { telemetrySnapshotCommand } from './generated';
export type {
  BrowserRequest,
  BrowserAction,
  BrowserBounds,
  BrowserEvent,
  BrowserLoadState,
  ImageRequest,
  ImagePreview,
  MediaError,
} from './generated';
export { decodeBrowserEvent, decodeImagePreview } from './lib/media-codec';
export type { WorkspacePaneOperation, WorkspacePaneLayout } from './generated';
