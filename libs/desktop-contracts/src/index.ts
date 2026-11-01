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
  IvyRequest,
  IvySubmitRequest,
  IvyComponent,
  IvyPresentation,
  IvySnapshot,
  IvyCommands,
} from './generated';
export {
  ivyConnectCommand,
  ivySnapshotCommand,
  ivySubmitCommand,
  ivyCancelCommand,
  ivyReconcileCommand,
  ivyDisconnectCommand,
  ivyEvent,
} from './generated';
export {
  decodeIvyRequest,
  decodeIvySubmitRequest,
  decodeIvyError,
  decodeIvySnapshot,
} from './lib/ivy-codec';
export type {
  SpeechState,
  SpeechError,
  SpeechRequest,
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
  decodeSpeechTranscribeRequest,
  decodeSpeechTranscript,
  decodeSpeechSpeakRequest,
  decodeSpeechSnapshot,
  decodeSpeechError,
} from './lib/speech-codec';
