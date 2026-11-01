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
