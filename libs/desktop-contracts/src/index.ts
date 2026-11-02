export type { ShellRequest, ShellReply, ShellError } from './generated';
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
} from './generated';
export {
  speechTranscribeCommand,
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

export type { CleanupRequest, CleanupReply } from './generated';
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
